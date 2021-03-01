const binaryen = require('binaryen');
const b = binaryen;

const Global = WebAssembly.Global;
const Memory = WebAssembly.Memory;

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

/// Clone of WebAssembly.Table that lets us store JS async functions
class Table {
    constructor({element, initial, maximum=undefined}) {
        if (element !== 'anyfunc') {
            throw new TypeError('Interpreter only supports anyfunc tables');
        }
        if (initial !== (initial | 0)) {
            throw new TypeError('invalid initial');
        }
        if (initial < 0 || initial > 2**32 - 1) {
            throw new RangeError('initial out of range');
        }

        const hasMaximum = (maximum !== undefined);
        if (hasMaximum) {
            if (maximum !== (maximum | 0)) {
                throw new TypeError('maximum must be number')
            }
            if (maximum < 0 || maximum > 2**32 - 1) {
                throw new RangeError('maximum out of range');
            }
            if (maximum < initial) {
                throw new RangeError('maximum smaller than initial');
            }
        }

        this._maximum = maximum;
        this._hasMaximum = hasMaximum;

        this._values = new Array(initial);
        for (let i = 0; i < initial; i++) {
            this._values[i] = null;
        }

        Object.defineProperty(this, 'length', {
            get: function () {
                return this._values.length;
            }
        });
    }

    get(index) {
        if (index !== (index | 0) || index < 0 || index > this.length) {
            throw new RangeError('invalid index');
        }
        return this._values[index];
    }

    set(index, value) {
        if (!(value instanceof Function)) {
            throw new TypeError('not a function');
        }
        if (index !== (index | 0) || index < 0 || index > this.length) {
            throw new RangeError('invalid index');
        }
        this._values[index] = value;
    }

    grow(number) {
        if (this._maximum && this.length + number > this._maximum) {
            throw new RangeError('out of range');
        }
        for (let i = 0; i < number; i++) {
            this._values.push(null);
        }
    }
}

// binaryen wants a Uint8Array
function normalizeBuffer(bufferSource) {
    if (bufferSource instanceof ArrayBuffer) {
        return new Uint8Array(bufferSource);
    } else if (bufferSource.buffer) {
        return new Uint8Array(bufferSource.buffer, bufferSource.byteOffset, bufferSource.byteLength);
    } else {
        throw RangeError("expected buffer source");
    }
}

/// Module class for reading a WebAssembly module.
class Module {
    constructor(bufferSource, {debug=false}) {
        this._mod = null;
        this._debug = debug;

        let input = normalizeBuffer(bufferSource);
        if (!b.isReady) {
            // copy in case the array changes later
            input = input.slice();
        }

        this.isReady = false;
        this.ready = b.ready.then(async () => {
            // @todo move the compilation in here
            // also allow reconstituting the JS source
            // and not having to touch binaryen
            this._mod = b.readBinary(input);
            this.isReady = true;
            return this;
        });
    }
}

function extendInts(arr) {
    // @todo extend in larger increments ;)
    const extended = new Int32Array(arr.length + 1);
    extended.set(arr);
    return extended;
}

class Instance {

    constructor(module, imports) {
        this.exports = {};

        // For debugging support
        this._debug = module._debug;
        this._singleStep = false;
        this._activeBreakpoints = new Int32Array();
        this._sequenceIndexes = new Int32Array();
        this._breakpoints = new Set();
        this._breakpointIndexes = new Map();
        this._sequences = [];
        this._activeSequences = new Int32Array();
        this.debugger = null;

        this._mod = module._mod;
        this._globals = {};
        this._funcs = {};
        this._functionNames = new Map();

        // @todo support multiples
        this._memory = null;
        this._table = null;

        this._ops = null;

        this._stackTracers = [];

        this.isReady = false;
        this.ready = b.ready.then(async () => {
            const mod = this._mod;

            // Memory
            if (mod.hasMemory()) {
                const memory = mod.getMemoryInfo();
                if (memory.module !== '') {
                    const imported = imports[memory.module][memory.base];
                    if (imported instanceof Memory) {
                        this._memory = imported;
                    } else {
                        throw new TypeError('Imported memory is not a WebAssembly memory');
                    }
                } else {
                    const memInit = {
                        initial: memory.initial
                    };
                    if (memory.max) {
                        memInit.maximum = memory.max;
                    }
                    if (memory.shared) {
                        throw new Error('Shared memory not yet supported');
                    }
                    this._memory = new Memory(memInit);
                }
                const buffer = this._memory.buffer;
                const numSegments = mod.getNumMemorySegments();
                const heap = new Uint8Array(buffer);
                for (let i = 0; i < numSegments; i++) {
                    const segment = mod.getMemorySegmentInfoByIndex(i);
                    if (!segment.passive) {
                        const offset = await evaluateConstant(segment.offset);
                        heap.set(offset, segment.data);
                    }
                }
            } else {
                throw new Error('Currently requires a memory');
            }

            // Create the ops module
            // This implements some binary ops via sync WebAssembly
            // @todo remove this
            this._ops = buildOpsModule();

            const evaluateConstant = async (expr) => {
                const func = Compiler.compileExpression(this, expr);
                return await func();
            };

            // Globals
            for (let i = 0; i < mod.getNumGlobals(); i++) {
                const info = b.getGlobalInfo(mod.getGlobalByIndex(i));
                const init = await evaluateConstant(info.init);
                const global = new Global({
                    value: typeCode(info.type),
                    mutable: info.mutable
                }, init);
                this._globals[info.name] = global;
            }

            // Prep internally-callable functions
            for (let i = 0; i < mod.getNumFunctions(); i++) {
                const func = b.getFunctionInfo(mod.getFunctionByIndex(i));
                let thunk;
                if (func.module === '') {
                    // Regular, non-imported function
                    thunk = Compiler.compileFunction(this, func);
                } else {
                    // Imports; note import functions may be sync or async.
                    const imported = imports[func.module][func.base];
                    if (imported instanceof Function) {
                        // @todo reuse thunk functions for same types?
                        const argNames = b.expandType(func.params).map((_, index) => `param${index}`);
                        const argList = argNames.join(', ');
                        let result;
                        const code = `
                            return async (${argList}) => {
                                ${
                                    result = `await imported(${argList})`,
                                    func.results === b.none
                                        ? `${result};`
                                        : `return ${coerceValue(func.results, result)};`
                                }
                            };
                        `;
                        thunk = (new Function('imported', code))(imported);
                    } else {
                        throw new RangeError("Expected function for import");
                    }
                }
                this._funcs[func.name] = thunk;
                this._functionNames.set(thunk, func.name);
            }

            // Function table
            const numTables = mod.getNumTables();
            if (numTables > 1) {
                throw new RangeError('Multiple tables not yet supported');
            }
            if (numTables > 0) {
                const table = b.getTableInfo(mod.getTableByIndex(0));
                if (table.module !== '') {
                    // @todo untested so far
                    this._table = imports[table.module][table.base];
                } else {
                    const init = {
                        element: 'anyfunc', // @todo how to get the element type? may need to extend again
                        initial: table.initial
                    };
                    if (table.max !== undefined) {
                        init.maximum = table.max;
                    }
                    this._table = new Table(init);
                }

                const funcTable = mod.getFunctionTable();
                for (let segment of funcTable.segments) {
                    let offset = await evaluateConstant(segment.offset);
                    const end = offset + segment.names.length;
                    if (this._table.length < end) {
                        this._table.grow(end - this._table.length);
                    }
                    for (let name of segment.names) {
                        this._table.set(offset++, this._funcs[name]);
                    }
                }
            }

            // Set up the exports...
            for (let i = 0; i < mod.getNumExports(); i++) {
                const ref = mod.getExportByIndex(i);
                const exp = b.getExportInfo(ref);

                let exported;
                switch (exp.kind) {
                    case b.ExternalFunction:
                        exported = this._funcs[exp.value];
                        break;
                    case b.ExternalTable:
                        exported = this._table;
                        break;
                    case b.ExternalMemory:
                        exported = this._memory;
                        break;
                    case b.ExternalGlobal:
                        exported = this._globals[exp.value];
                        break;
                    default:
                        throw new RangeError("Unexpected export type");
                }
                this.exports[exp.name] = exported;
            }

            this.isReady = true;
            return this;
        });
    }

    /// Generate a full stack trace, dumping stacks and locals from
    /// the internal state of each function on the call stack.
    /// These are Frame objects.
    stackTrace(start=undefined, end=undefined) {
        const stack = this._stackTracers.slice(start, end);
        return stack.map((dump) => dump());
    }

    setBreakpoint(sourceLocation) {
        if (!this.hasBreakpoint(sourceLocation)) {
            const index = this._breakpointIndex(sourceLocation);
            if (!this._singleStep) {
                this._activeBreakpoints[index] = 1;
    
                const sequence = this._sequenceIndexes[index];
                if (sequence != -1) {
                    this._activeSequences[sequence]++;
                }
            }
        }
    }

    clearBreakpoint(sourceLocation) {
        if (this.hasBreakpoint(sourceLocation)) {
            const index = this._breakpointIndex(sourceLocation);
            if (!this._singleStep) {
                this._activeBreakpoints[index] = 0;

                const sequence = this._sequenceIndexes[index];
                if (sequence != -1) {
                    this._activeSequences[sequence]--;
                }
            }
            this._breakpoints.delete(sourceLocation);
        }
    }

    hasBreakpoint(sourceLocation) {
        return this._breakpoints.has(sourceLocation);
    }

    breakpoints() {
        return Array.from(this._breakpoints.keys());
    }

    get singleStep() {
        return this._singleStep;
    }

    set singleStep(val) {
        val = Boolean(val);
        if (val == this._singleStep) {
            return;
        }
        if (val) {
            // Set the breakpoint bitmaps ALL ON
            this._activeBreakpoints.fill(1);
            this._activeSequences.fill(1);
        } else {
            // Set the breakpoint bitmaps to their correct values
            this._activeBreakpoints.fill(0);
            this._activeSequences.fill(0);
            for (let index of this._breakpoints) {
                this._activeBreakpoints[index] = 1;
                const sequence = this._sequenceIndexes[index];
                if (sequence > -1) {
                    this._activeSequences[sequence]++;
                }
            }
        }
        this._singleStep = val;
    }

    _breakpointIndex(sourceLocation) {
        const nodes = this._breakpointIndexes;
        if (nodes.has(sourceLocation)) {
            return nodes.get(sourceLocation);
        } else {
            const index = this._activeBreakpoints.length;
            this._activeBreakpoints = extendInts(this._activeBreakpoints);
            this._sequenceIndexes = extendInts(this._sequenceIndexes);
            this._sequenceIndexes[index] = -1;

            nodes.set(sourceLocation, index);
            return index;
        }
    }

    _registerSequence(sourceLocations) {
        const indexes = sourceLocations.map((loc) => this._breakpointIndex(loc));
        const sequence = this._sequences.push(indexes) - 1;
        this._activeSequences = extendInts(this._activeSequences);
        for (let loc of sourceLocations) {
            const index = this._breakpointIndex(loc);
            this._sequenceIndexes[index] = sequence;
        }
        return sequence;
    }
}

/// Parse a module from binary form and prepare it to be instantiated later.
/// Currently this compilation is done synchronously on the main thread,
/// but please use this async API for future-proofing.
async function compile(bufferSource, options={}) {
    const module = new Module(bufferSource, options);
    return await module.ready;
}

/// Parse a module from a stream containing binary form and prepare it to be
/// instantiated later. Currently this compilation is done synchronously on
/// the main thread after the whole stream is collected in memory, but please
/// use this async API for future-proofing.
async function compileStreaming(source, options={}) {
    const response = await source;
    const buffer = await response.arrayBuffer();
    const module = new Module(buffer, options);
    return await module.ready;
}

/// Parse/compile and instantiate from a buffer
async function instantiate(bufferSource, importObject, options={}) {
    const module = await compile(bufferSource, options);
    const instance = new Instance(module, importObject);
    await instance.ready;
    return {
        module,
        instance
    };
}

/// Parse/compile and instantiate from a Response or Promise<Response>
async function instantiateStreaming(source, importObject, options={}) {
    const module = await compileStreaming(source, options);
    const instance = new Instance(module, importObject);
    await instance.ready;
    return {
        module,
        instance
    };
}


function typeCode(type) {
    switch (type) {
        case b.i32:
            return 'i32';
        case b.i64:
            return 'i64';
        case b.f32:
            return 'f32';
        case b.f64:
            return 'f64';
        default:
            throw new RangeError('invalid type');
    }
}

function defaultValue(type) {
    switch (type) {
        case b.i32:
            return 0;
        case b.i64:
            return 0n;
        case b.f32:
        case b.f64:
            return 0.0;
        default:
            return null;
    }
}

function coerceValue(type, value) {
    switch (type) {
        case b.i32:
            return `(${value} | 0)`;
        case b.i64:
            return `BigInt.asIntN(64, BigInt(${value}))`;
        case b.f32:
            return `Math.fround(${value})`;
        case b.f64:
            return `+${value}`;
        default:
            // Assume others are reference types?
            return `${value}`;
    }
}

function sizeof(type) {
    switch (type) {
        case b.none:
            return 0;
        case b.i32:
            return 4;
        case b.i64:
            return 8;
        case b.f32:
            return 4;
        case b.f64:
            return 8;
        default:
            throw new Error('bad type');
    }
}

function resultCount(type) {
    switch (type) {
        case b.none:
            return 0;
        case b.i32:
        case b.i64:
        case b.f32:
        case b.f64:
            return 1;
        default:
            return b.expandType(type).length;
    }
}

let expressions = null;
function expressionMap(id) {
    if (!expressions) {
        const ids = [
            'Block',
            'If',
            'Loop',
            'Break',
            'Switch',
            'Call',
            'CallIndirect',
            'LocalGet',
            'LocalSet',
            'GlobalGet',
            'GlobalSet',
            'Load',
            'Store',
            'Const',
            'Unary',
            'Binary',
            'Select',
            'Drop',
            'Return',
            'MemorySize',
            'MemoryGrow',
            'Nop',
            'Unreachable'
        ];
        expressions = {};
        for (let name of ids) {
            const val = binaryen[name + 'Id'];
            expressions[val] = '_compile' + name;
        }
    }
    return expressions[id];
}

/// Dumped execution state frame for a single function.
///
/// Returned with stack traces from `Interpreter.prototype.stackTrace`
class Frame {
    constructor(instance) {
        this.instance = instance;
        this.name = '';
        this.sourceLocation = null;
        this.stack = null;
        this.locals = null;
    }
}

function* range(end) {
    for (let i = 0; i < end; i++) {
        yield i;
    }
}

function getExpressionInfo(expr) {
    if (typeof expr === 'object') {
        return expr;
    } else {
        // Keep the reference ID on the info object as we pass it around.
        // This is a placeholder until we can retain source locations that
        // make sense (eg against the binary, or against a generated text
        // disassembly).
        const info = b.getExpressionInfo(expr);
        info.sourceLocation = String(expr);
        return info;
    }
}

function memoryExpression(expr) {
    const info = getExpressionInfo(expr);
    switch (info.id) {
        case b.LoadId:
        case b.StoreId:
            return true;
        default:
            return false;
    }
}

function infallible(expr) {
    const info = getExpressionInfo(expr);
    switch (info.id) {
        case b.BlockId:
            return info.children.filter(infallible).length == info.children.length;
        case b.IfId:
            return infallible(info.condition) &&
                infallible(info.ifTrue) &&
                (!info.ifFalse || infallible(info.true))
        case b.LoopId:
            return infallible(info.body);
        case b.BreakId:
            return !info.condition || infallible(info.condition);
        case b.SwitchId:
            return infallible(info.condition);
        case b.CallId:
            // @todo analyze all statically linked internal functions
            // and pass through a true if possible
        case b.CallIndirectId:
            return false;
        case b.LocalGetId:
        case b.LocalSetId:
        case b.GlobalGetId:
        case b.GlobalSetId:
            return true;
        case b.LoadId:
        case b.StoreId:
            return false;
        case b.ConstId:
            return true;
        case b.UnaryId:
            return infallible(info.value);
        case b.BinaryId:
            switch (info.op) {
                case b.DivSInt32:
                case b.DivSInt64:
                case b.DivFloat32:
                case b.DivFloat64:
                    return false;
                default:
                    return infallible(info.left) &&
                    infallible(info.right);
            }
        case b.SelectId:
            return infallible(info.ifTrue) &&
                infallible(info.ifFalse) &&
                infallible(info.condition);
        case b.DropId:
        case b.ReturnId:
        case b.MemorySizeId:
            return true;
        case b.MemoryGrowId:
            return false;
        case b.NopId:
            return true;
        case b.UnreachableId:
            return false;
        default:
            throw new Error('Invalid expression id');
    }
}

function uninterruptible(expr) {
    const info = getExpressionInfo(expr);
    switch (info.id) {
        case b.BlockId:
            // Note block children are *not* like inputs!
            // We need to transit them because they happen inside our node's output.
            //return info.children.filter(uninterruptible).length == info.children.length;
            return false;
        case b.IfId:
            return false;
            return uninterruptible(info.ifTrue) &&
                (!info.ifFalse || uninterruptible(info.true))
        case b.LoopId:
            return false;
            return uninterruptible(info.body);
        case b.BreakId:
            return true;
        case b.SwitchId:
            return true;
        case b.CallId:
            // @todo analyze all statically linked internal functions
            // and pass through a true if possible
            return false;
        case b.CallIndirectId:
        case b.LocalGetId:
        case b.LocalSetId:
        case b.GlobalGetId:
        case b.GlobalSetId:
        case b.LoadId:
        case b.StoreId:
        case b.ConstId:
        case b.UnaryId:
        case b.BinaryId:
        case b.SelectId:
        case b.DropId:
        case b.ReturnId:
        case b.MemorySizeId:
        case b.MemoryGrowId:
        case b.NopId:
        case b.UnreachableId:
            return true;
        default:
            throw new Error('Invalid expression id');
    }
}

// move these into generated code

// Borrowed from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/clz32
function ctz32(n){
    n |= n << 16;
    n |= n << 8;
    n |= n << 4;
    n |= n << 2;
    n |= n << 1;
    return 32 - Math.clz(~n);
}

function ctz64(n) {
    n |= n << 32n;
    n |= n << 16n;
    n |= n << 8n;
    n |= n << 4n;
    n |= n << 2n;
    n |= n << 1;
    const low = BigInt.toIntN(32, n);
    const trailing = 32 - Math.clz(~low);
    if (trailing == 32) {
        const high = Number(BigInt.toIntN(32, n >> 32n));
        return 64 - Math.clz(~high);
    }
}

function clz64(n) {
    const high = Number(BigInt.toIntN(32, n >> 32n));
    const leading = Math.clz32(high);
    if (leading === 32) {
        const low = Number(BigInt.toIntN(32, n));
        return 32 + Math.clz32(low);
    } else {
        return leading;
    }
}

const bitsPerByte = new Uint8Array(Array.from(range(256)).map((n) => {
    let bits = 0;
    bits += (n & 1) | 0;
    bits += (n & 2) >> 1 | 0;
    bits += (n & 4) >> 2 | 0;
    bits += (n & 8) >> 3 | 0;
    bits += (n & 16) >> 4 | 0;
    bits += (n & 32) >> 5 | 0;
    bits += (n & 64) >> 6 | 0;
    bits += (n & 128) >> 7 | 0;
    return bits;
}));

function popcnt32(n) {
    return bitsPerByte[n & 0xff] +
        bitsPerByte[(n >> 8) & 0xff] +
        bitsPerByte[(n >> 16) & 0xff] +
        bitsPerByte[(n >> 24) & 0xff];
}

function popcnt64(n) {
    const high = Number(BigInt.toIntN(32, n >> 32n));
    const low = Number(BigInt.toIntN(32, n));
    return popcnt32(high) + popcnt32(low);
}

// move this into instance state maybe?
const reinterpretBuffer = new ArrayBuffer(8);
const reinterpretView = new DataView(reinterpretBuffer);


class Compiler {
    constructor(instance, params=[], vars=[]) {
        this.instance = instance;
        this.paramTypes = params.slice();
        this.localDefaults = params.concat(vars).map(defaultValue);
        this.closure = [];
        this.closureMap = new Map();
        this.labels = [];
        this.sources = [];
        this.stack = [];
        this.maxDepth = 0;
    }

    static compileBase(instance, expr, params, results, vars, name='<anonymous>') {
        const compiler = new Compiler(instance, params, vars);
        const inst = compiler.enclose(instance);
        const paramNames = params.map((_type, index) => `param${index}`);
        const body = compiler.flatten(compiler.compile(expr));
        const hasResult = (results !== b.none);
        const func = `
            return async (${paramNames.join(', ')}) => {
                const instance = ${inst};
                const table = instance._table;
                const memory = instance._memory;
                let buffer = memory.buffer;
                let dataView = new DataView(buffer); // @fixme use a common one to avoid allocating
                const updateViews = () => {
                    buffer = memory.buffer;
                    dataView = new DataView(buffer); // @fixme run this through a common cache
                };
                ${
                    compiler.maxDepth
                    ? `let ${compiler.stackVars(compiler.maxDepth).join(`, `)};`
                    : ``
                }
                ${
                    compiler.localDefaults.length
                    ? `let ${compiler.localInits(paramNames).join(`, `)};`
                    : ``
                }
                let node;
                ${instance._debug ? `
                    const activeBreakpoints = instance._activeBreakpoints;
                    const activeSequences = instance._activeSequences;
                    const stackSpill = [${
                        Array.from(range(compiler.maxDepth + 1), (_, depth) => {
                            return `
                                () => [${compiler.stackVars(depth).join(`, `)}]
                            `;
                        }).join(',\n')
                    }];
                ` : ``}
                const dump = () => {
                    const frame = /* Frame */ new ${compiler.enclose(Frame)}(instance);
                    frame.name = ${compiler.literal(name)};
                    ${instance._debug ? `
                        frame.stack = stackSpill[node.depth]();
                        frame.locals = [${compiler.localVars().join(`, `)}];
                    ` : ``}
                    frame.sourceLocation = node.sourceLocation;
                    return frame;
                };
                instance._stackTracers.push(dump);
                try {
                    ${body}
                    ${hasResult ? `return ${compiler.pop()};` : ``}
                } finally {
                    instance._stackTracers.pop();
                }
            };
        `;
        const closureNames = compiler.closure.map((_val, index) => `closure${index}`);
        const args = closureNames.concat([func]);
        //console.log({closureNames, closure: compiler.closure})
        //console.log(func);
        return Reflect.construct(Function, args).apply(null, compiler.closure);
    }

    static compileFunction(instance, func) {
        return Compiler.compileBase(instance, func.body, b.expandType(func.params), func.results, func.vars, func.name)
    }

    static compileExpression(instance, expr) {
        return Compiler.compileBase(instance, expr, [], expr.type, []);
    }

    /// Compile a single expression from the AST into an array
    // of JS async function source fragments and metadata
    compile(expression) {
        const expr = getExpressionInfo(expression);
        const handler = expressionMap(expr.id);
        if (this[handler]) {
            return this[handler](expr);
        } else {
            //console.log({expression});
            throw new RangeError("Cannot compile unknown expression");
        }
    }

    flatten(nodes) {
        const cleanPath = (node) => `
            ${node.infallible ? `` : node.spill}
            ${node.fragment}
        `;
        const dirtyPath = (node) => `
            ${node.infallible ? `` : node.spill}
            if (activeBreakpoints[${this.instance._breakpointIndex(node.sourceLocation)}]) {
                ${node.infallible ? node.spill : ``}
                await instance.debugger();
                ${node.memory ? `
                    if (buffer !== memory.buffer) {
                        updateViews();
                    }
                ` : ``}
            }
            ${node.fragment}
        `;
        const bifurcate = (nodes) => {
            const sequence = this.instance._registerSequence(
                nodes.map((node) => node.sourceLocation)
            );
            return `
                ${nodes.filter((node) => node.memory).length ? `
                if (buffer !== memory.buffer) {
                    updateViews();
                }
                `: ``}
                if (activeSequences[${sequence}]) {
                    ${nodes.map(dirtyPath).join('\n')}
                } else {
                    ${nodes.map(cleanPath).join('\n')}
                }
            `;
        };
        if (this.instance._debug) {
            let source = ``;
            const streak = [];
            const spillStreak = () => {
                if (streak.length > 1) {
                    source += bifurcate(streak);
                } else if (streak.length == 1) {
                    source += dirtyPath(streak[0])
                }
                streak.splice(0, streak.length);
            };
            for (let node of nodes) {
                if (node.uninterruptible) {
                    streak.push(node);
                } else {
                    spillStreak();
                    source += dirtyPath(node);
                }
            }
            spillStreak();
            return source;
        } else {
            return `
                ${nodes.map(cleanPath).join('\n')}
            `;
        }
    }

    enclose(val) {
        let index = this.closureMap.get(val);
        if (index === undefined) {
            index = this.closure.push(val) - 1;
            this.closureMap.set(val, index);
        }
        return 'closure' + index;
    }

    literal(value) {
        switch (typeof value) {
            case 'number':
            case 'string': // used for function names
                return JSON.stringify(value);
            case 'bigint':
                return `${value}n`;
            default:
                return `/* literal */ ${this.enclose(value)}`;
        }
    }

    label(name) {
        let index = this.labels.indexOf(name);
        if (index === -1) {
            index = this.labels.push(name) - 1;
        }
        return 'label' + index;
    }

    spill(expr) {
        // @todo ship these object literals in the generated wrapper
        // function instead of live objects, so we can reconstitute source.
        // object literals should be avoided so we only have to do a single
        // property store on this code path
        const node = {
            sourceLocation: expr.sourceLocation
        };
        if (this.instance._debug) {
            node.depth = this.literal(this.stack.length);
        }
        return `
                node = ${this.enclose(node)};
        `;
    }

    opcode(expr, args, builder) {
        const nodes = args.flatMap((arg) => this.compile(arg));
        const spill = this.spill(expr);
        const stackVars = args.map((_) => this.pop()).reverse();
        let result;
        if (expr.type != b.none) {
            // quick hack for getting the stack variable name
            // for the value pushed by the opcode
            this.push();
            result = this.pop();
            this.push();
        }
        nodes.push({
            sourceLocation: expr.sourceLocation,
            uninterruptible: uninterruptible(expr),
            infallible: infallible(expr),
            fragment: builder(result, ...stackVars),
            memory: memoryExpression(expr),
            spill
        });

        return nodes;
    }

    vars(base, max) {
        return Array.from(range(max), (_, i) => `${base}${i}`);
    }

    stackVars(max) {
        return this.vars(`stack`, max);
    }

    localVars() {
        return this.vars(`local`, this.localDefaults.length);
    }

    localInits(paramNames) {
        return this.localDefaults.map((value, index) => {
            if (index < paramNames.length) {
                const type = this.paramTypes[index];
                const name = paramNames[index];
                return `local${index} = ${coerceValue(type, name)}`;
            }
            return `local${index} = ${this.literal(value)}`;
        });
    }

    push(val) {
        const depth = this.stack.push(true);
        if (depth > this.maxDepth) {
            this.maxDepth = depth;
        }
        return `stack${depth - 1} = ${val};`;
    }

    pop() {
        const depth = this.stack.length;
        this.stack.pop();
        return `stack${depth - 1}`;
    }

    saveStack() {
        return this.stack.length;
    }

    restoreStack(saved, preserve=0) {
        const depth = this.stack.length;
        this.stack.splice(saved, (depth - saved) - preserve);

        const copies = [];
        for (let i = 0; i < preserve; i++) {
            copies.push(`stack${saved + i} = stack${(depth - preserve) + i};`);
        }
        return copies.join('\n');
    }

    _compileBlock(expr) {
        let saved;
        if (expr.name !== '') {
            let label;
            return this.opcode(expr, [], (result) => `
                {
                    ${(saved = this.saveStack()), ``}
                    ${label = this.label(expr.name)}:
                    do {
                        ${this.flatten(expr.children.flatMap((expr) => this.compile(expr)))}
                    } while (false)
                    ${this.restoreStack(saved, resultCount(expr.type))}
                }
            `);
        }
        return this.opcode(expr, expr.children, () => ``);
    }

    _compileIf(expr) {
        return this.opcode(expr, [expr.condition], (result, condition) => `
            if (${condition}) {
                ${this.flatten(this.compile(expr.ifTrue))}
            }
            ${
                expr.ifFalse
                ? `else {
                    ${this.flatten(this.compile(expr.ifFalse))}
                }`
                : ``
            }
        `);
    }

    _compileLoop(expr) {
        let outer, inner, saved;
        return this.opcode(expr, [], (result) => `
            {
                ${(saved = this.saveStack()), ``}
                ${outer = this.label(expr.name + '$$loop')}:
                for (;;) {
                    ${inner = this.label(expr.name)}:
                    for (;;) {
                        ${this.flatten(this.compile(expr.body))}
                        break ${outer};
                    }
                }
                ${this.restoreStack(saved, resultCount(expr.type))}
            }
        `);
    }

    _compileBreak(expr) {
        const breaker = `
            break ${this.label(expr.name)};
        `;
        if (expr.condition) {
            return this.opcode(expr, [expr.condition], (result, condition) => `
                if (${condition}) {
                    ${breaker}
                }
            `);
        } else {
            return this.opcode(expr, [], () => breaker);
        }
    }

    _compileSwitch(expr) {
        const labels = expr.names.map((name) => this.label(name));
        return this.opcode(expr, [expr.condition], (result, condition) => `
            switch (${condition}) {
                ${labels.map((label, index) => `
                    case ${index}:
                        break ${label};
                `).join('\n')}
                default:
                    break ${this.label(expr.defaultName)};
            }
        `);
    }

    _compileCall(expr) {
        const func = this.instance._funcs[expr.target];
        const name = this.instance._functionNames.get(func);
        return this.opcode(expr, expr.operands, (result, ...args) => {
            const call = `await /* ${name} */ ${this.enclose(func)}(${args.join(', ')})`;
            return result
                    ? `${result} = ${call};`
                    : `${call};`;
        });
    }

    _compileCallIndirect(expr) {
        return this.opcode(expr, [expr.target].concat(expr.operands), (result, target, ...args) => {
            // @todo enforce signature matches
            const call = `await (table.get(${target}))(${args.join(`, `)})`;
            return result
                    ? `${result} = ${call};`
                    : `${call};`;
        });
    }

    local(index) {
        return `local${index}`;
    }

    global(name) {
        return `/* global ${this.literal(name)} */ ${this.enclose(this.instance._globals[name])}`;
    }

    _compileLocalGet(expr) {
        return this.opcode(expr, [], (result) =>
            `${result} = ${this.local(expr.index)};`
        );
    }

    _compileLocalSet(expr) {
        return this.opcode(expr, [expr.value], (result, value) => `
            ${this.local(expr.index)} = ${value};
        `);
    }

    _compileGlobalGet(expr) {
        return this.opcode(expr, [], (result) => `
            ${result} = ${this.global(expr.name)}.value;
        `);
    }

    _compileGlobalSet(expr) {
        return this.opcode(expr, [expr.value], (result, value) => `
            ${this.global(expr.name)}.value = ${value};
        `);
    }

    memoryLoad(expr, ptr) {
        const bits = expr.bytes * 8;
        const type = expr.type || getExpressionInfo(expr.value).type;
        let method;
        const offset = expr.offset ? `${ptr} + ${expr.offset}` : ptr;
        const signed = (expr.isSigned || expr.bytes == sizeof(type));
        switch (type) {
            case b.i32:
            case b.i64:
                const big = (type === b.i64) ? `Big` : ``;
                method = signed ? `get${big}Int${bits}` : `get${big}Uint${bits}`;
                let call = `dataView.${method}(${offset}, true)`;
                if (type === b.i64 && bits < 64) {
                    return `BigInt(${call})`
                } else {
                    return call;
                }
                break;
            case b.f32:
            case b.f64:
                method = `getFloat${bits}`
                return `dataView.${method}(${offset}, true)`
            default:
                throw new Error('bad type');
        }
    }

    memoryStore(expr, ptr, value) {
        const bits = expr.bytes * 8;
        const type = expr.type || getExpressionInfo(expr.value).type;
        let method;
        const offset = expr.offset ? `${ptr} + ${expr.offset}` : ptr;
        switch (type) {
            case b.i32:
            case b.i64:
                const big = (type === b.i64) ? `Big` : ``;
                method = `set${big}Int${bits}`;
                let input;
                if (type === b.i64 && bits < 64) {
                    input = `Number(BigInt.asIntN(${bits}, ${input}))`
                } else {
                    input = value;
                }
                let call = `dataView.${method}(${offset}, ${input}, true)`;
                return call;
                break;
            case b.f32:
            case b.f64:
                method = `setFloat${bits}`
                return `dataView.${method}(${offset}, ${value}, true)`
            default:
                throw new Error('bad type');
        }
    }

    _compileLoad(expr) {
        return this.opcode(expr, [expr.ptr], (result, ptr) =>
            `${result} = ${this.memoryLoad(expr, ptr)};`
        );
    }

    _compileStore(expr) {
        return this.opcode(expr, [expr.ptr, expr.value], (_result, ptr, value) =>
            `${this.memoryStore(expr, ptr, value)};`
        );
    }

    _compileConst(expr) {
        let value;
        if (expr.type == b.i64) {
            const {high, low} = expr.value;
            value = (BigInt(high | 0) << 32n) | BigInt(low >>> 0);
        } else {
            value = expr.value;
        }
        return this.opcode(expr, [], (result) => `
            ${result} = ${this.literal(value)};
        `);
    }
    
    unaryOp(op, operand) {
        switch (op) {
        case b.ClzInt32:
            return `Math.clz32(${operand})`;
        case b.ClzInt64:
            return `/* clz64 */ ${this.enclose(clz64)}(${operand})`
        case b.CtzInt32:
            return `/* ctz32 */ ${this.enclose(ctz32)}(${operand})`;
        case b.CtzInt64:
            return `/* ctz64 */ ${this.enclose(ctz64)}(${operand})`;
        case b.PopcntInt32:
            return `/* popcnt32 */ ${this.enclose(popcnt32)}(${operand})`;
        case b.PopcntInt64:
            return `/* popcnt64 */ ${this.enclose(popcnt64)}(${operand})`;
        case b.NegFloat32:
        case b.NegFloat64:
            return `-${operand}`;
        case b.AbsFloat32:
        case b.AbsFloat64:
            return `Math.abs(${operand})`;
        case b.CeilFloat32:
        case b.CeilFloat64:
            return `Math.ceil(${operand})`;
        case b.FloorFloat32:
        case b.FloorFloat64:
            return `Math.floor(${operand})`;
        case b.TruncFloat32:
        case b.TruncFloat64:
            return `Math.trunc(${operand})`;
        case b.NearestFloat32:
        case b.NearestFloat64:
            return `Math.round(${operand})`;
        case b.SqrtFloat32:
            return `Math.fround(Math.sqrt(${operand}))`;
        case b.SqrtFloat64:
            return `Math.sqrt(${operand})`;
        case b.EqZInt32:
        case b.EqZInt64:
            return `!${operand} | 0`;
        case b.TruncSFloat32ToInt32:
        case b.TruncSFloat64ToInt32:
            // @fixme this should throw when out of range or NaN
            return `${operand} | 0`;
        case b.TruncUFloat32ToInt32:
        case b.TruncUFloat64ToInt32:
            // @fixme this should throw when out of range or NaN
            return `$({operand} >>> 0) | 0`;
        case b.TruncSFloat32ToInt64:
        case b.TruncSFloat64ToInt64:
            // @fixme this should throw when out of range or NaN
            return `BigInt.toIntN(64, BigInt(${operand}))`;
        case b.TruncUFloat32ToInt64:
        case b.TruncUFloat64ToInt64:
            // @fixme this should throw when out of range or NaN
            return `BigInt.toIntN(64, BigInt(${operand}))`;
        case b.ReinterpretFloat32:
            {
                const view = this.enclose(reinterpretView);
                return `/* reinterpret */
                    ${view}.setFloat32(0, ${operand}, true),
                    ${view}.getInt32(0, true)
                `;
            }
        case b.ReinterpretFloat64:
            {
                const view = this.enclose(reinterpretView);
                return `/* reinterpret */
                    ${view}.setFloat64(0, ${operand}, true),
                    ${view}.getBigInt64(0, true)
                `;
            }
        case b.ConvertSInt32ToFloat32:
            return `${this.enclose(Math.fround)}(+${operand})`;
        case b.ConvertSInt32ToFloat64:
            return `+${operand}`;
        case b.ConvertUInt32ToFloat32:
            return `${this.enclose(Math.fround)}(+(${operand} >>> 0))`;
        case b.ConvertUInt32ToFloat64:
            return `+(${operand} >>> 0)`;
        case b.ConvertSInt64ToFloat32:
            return `+Number(${operand})`;
        case b.ConvertSInt64ToFloat64:
            return `${this.enclose(Math.fround)}(+Number(${operand}))`;
        case b.ConvertUInt64ToFloat32:
            return `+Number(BigInt.asUintN(64, ${operand}))`;
        case b.ConvertUInt64ToFloat64:
            return `${this.enclose(Math.fround)}(+Number(BigInt.asUintN(64, ${operand})))`;
        case b.PromoteFloat32:
            return `${operand}`;
        case b.DemoteFloat64:
            return `Math.fround(${operand})`;
        case b.ReinterpretInt32:
            {
                const view = this.enclose(reinterpretView);
                return `/* reinterpret */
                    ${view}.setInt32(0, ${operand}, true),
                    ${view}.getFloat32(0, true)
                `;
            }
        case b.ReinterpretInt64:
            {
                const view = this.enclose(reinterpretView);
                return `/* reinterpret */
                    ${view}.setInt64(0, ${operand}, true),
                    ${view}.getFloat64(0, true)
                `;
            }
        default:
            throw new Error('Unknown unary op ${op}');
        }
    }

    _compileUnary(expr) {
        return this.opcode(expr, [expr.value], (result, value) => `
            ${result} = ${this.unaryOp(expr.op, value)};
        `);
    }

    binaryOp(op, left, right) {
        switch (op) {
            case b.AddInt32:
                return `${left} + ${right} | 0`;
            case b.AddInt64:
                return `BigInt.asIntN(64, ${left} + ${right})`;
            case b.AddFloat32:
                return `${this.enclose(Math.fround)}(${left} + ${right})`;
            case b.AddFloat64:
                return `${left} + ${right}`;
            case b.SubInt32:
                return `${left} - ${right} | 0`;
            case b.SubInt64:
                return `BigInt.asIntN(64, ${left} - ${right})`;
            case b.SubFloat32:
                return `${this.enclose(Math.fround)}(${left} - ${right})`;
            case b.SubFloat64:
                return `${left} - ${right}`;
            case b.MulInt32:
                return `Math.imul(${left}, ${right})`;
            case b.MulInt64:
                return `BigInt.asIntN(64, ${left} * ${right})`;
            case b.MulFloat32:
                return `${this.enclose(Math.fround)}(${left} * ${right})`;
            case b.MulFloat64:
                return `${left} * ${right}`;
            case b.DivInt32:
                return `(${left} / ${right}) | 0`;
            case b.DivInt64:
                return `${left} / ${right}`;
            case b.DivFloat32:
                return `${this.enclose(Math.fround)}(${left} / ${right})`;
            case b.DivFloat64:
                return `${left} / ${right}`;
            case b.AndInt32:
            case b.AndInt64:
                return `${left} & ${right}`;
            case b.OrInt32:
            case b.OrInt64:
                return `${left} | ${right}`;
            case b.XorInt32:
            case b.XorInt64:
                return `${left} ^ ${right}`;
            case b.ShlInt32:
                return `${left} << ${right}`;
            case b.ShlInt64:
                return `BigInt.asIntN(64, ${left} << (${right} & 63n))`;
            case b.ShrSInt32:
                return `${left} >> ${right}`;
            case b.ShrUInt32:
                return `(${left} >>> ${right}) | 0`;
            case b.ShrUInt64:
                return `BigInt.asIntN(64, BigInt.asUintN(64, ${left}) >> (${right} & 63n)))`;
            case b.EqInt32:
            case b.EqInt64:
                return `(${left} === ${right}) | 0`;
            case b.NeInt32:
            case b.NeInt64:
                return `(${left} !== ${right}) | 0`;
            case b.LtSInt32:
                return `(${left} < ${right}) | 0`;
            case b.LtUInt32:
                return `((${left} >>> 0) < (${right} >>> 0)) | 0`;
            case b.LtFloat32:
            case b.LtFloat64:
                return `(${left} < ${right}) | 0`;
            case b.LeSInt32:
                return `(${left} <= ${right}) | 0`;
            case b.LeUInt32:
                return `((${left} >>> 0) <= (${right} >>> 0)) | 0`;
            case b.LeFloat32:
            case b.LeFloat64:
                return `(${left} <= ${right}) | 0`;
            case b.GtSInt32:
                return `(${left} > ${right}) | 0`;
            case b.GtUInt32:
                return `((${left} >>> 0) > (${right} >>> 0)) | 0`;
            case b.GtFloat32:
            case b.GtFloat64:
                return `(${left} > ${right}) | 0`;
            case b.GeSInt32:
                return `(${left} >= ${right}) | 0`;
            case b.GeUInt32:
                return `((${left} >>> 0) >= (${right} >>> 0)) | 0`;
            case b.GeFloat32:
            case b.GeFloat64:
                return `(${left} >= ${right}) | 0`;
            default:
                const func = this.instance._ops.binary[op];
                return `/* binary${op} */ ${this.enclose(func)}(${left}, ${right})`;
        }
    }

    _compileBinary(expr) {
        return this.opcode(expr, [expr.left, expr.right], (result, left, right) => `
            ${result} = ${this.binaryOp(expr.op, left, right)};
        `);
    }

    _compileSelect(expr) {
        return this.opcode(expr, [expr.ifTrue, expr.ifFalse, expr.condition], (result, ifTrue, ifFalse, condition) => `
            ${result} = ${condition} ? ${ifTrue} : ${ifFalse};
        `);
    }

    _compileDrop(expr) {
        return this.opcode(expr, [expr.value], (result) => ``);
    }

    _compileMemorySize(expr) {
        const memory = this.enclose(this.instance._memory);
        return this.opcode(expr, [], (result) => `
            ${result} = /* memory */ ${memory}.buffer.length / 65536;
        `);
    }

    _compileMemoryGrow(expr) {
        // @fixme check for growth requirements on demand in debug path or async
        const memory = this.enclose(this.instance._memory);
        return this.opcode(expr, [expr.delta], (result, delta) => `
            ${result} = /* memory */ ${memory}.grow(${delta});
            instance._updateViews();
        `);
    }

    _compileReturn(expr) {
        if (expr.value) {
            return this.opcode(expr, [expr.value], (result, value) => `
                return ${value};
            `)
        }
        return this.opcode(expr, [], () => `
            return;
        `)
    }

    _compileNop(expr) {
        return this.opcode(expr, [], () => ``);
    }

    _compileUnreachable(expr) {
        return this.opcode(expr, [], () => `
            throw new WebAssembly.RuntimeError("Unreachable");
        `);
    }
}

function buildOpsModule() {
    const m = b.parseText("(module)");

    const promote = (expr, type) => {
        if (type == b.f32) {
            return m.f64.promote(expr);
        }
        return expr;
    };
    const demote = (expr, type) => {
        if (type == b.f32) {
            return m.f32.demote(expr);
        }
        return expr;
    };
    const adapt = (type) => {
        if (type == b.f32) {
            return b.f64;
        }
        return type;
    };

    const binaryOps = [
        [b.AddInt32, m.i32.add, b.i32, b.i32],
        [b.AddInt64, m.i64.add, b.i64, b.i64],
        [b.AddFloat32, m.f32.add, b.f32, b.f32],
        [b.AddFloat64, m.f64.add, b.f64, b.f64],
        [b.SubInt32, m.i32.sub, b.i32, b.i32],
        [b.SubInt64, m.i64.sub, b.i64, b.i64],
        [b.SubFloat32, m.f32.sub, b.f32, b.f32],
        [b.SubFloat64, m.f64.sub, b.f64, b.f64],
        [b.MulInt32, m.i32.mul, b.i32, b.i32],
        [b.MulInt64, m.i64.mul, b.i64, b.i64],
        [b.MulFloat32, m.f32.mul, b.f32, b.f32],
        [b.MulFloat64, m.f64.mul, b.f64, b.f64],
        [b.DivSInt32, m.i32.div_s, b.i32, b.i32],
        [b.DivSInt64, m.i64.div_s, b.i64, b.i64],
        [b.DivUInt32, m.i32.div_u, b.i32, b.i32],
        [b.DivUInt64, m.i64.div_u, b.i64, b.i64],
        [b.DivFloat32, m.f32.div, b.f32, b.f32],
        [b.DivFloat64, m.f64.div, b.f64, b.f64],
        [b.RemSInt32, m.i32.rem_s, b.i32, b.i32],
        [b.RemSInt64, m.i64.rem_s, b.i64, b.i64],
        [b.RemUInt32, m.i32.rem_u, b.i32, b.i32],
        [b.RemUInt64, m.i64.rem_u, b.i64, b.i64],
        [b.AndInt32, m.i32.and, b.i32, b.i32],
        [b.AndInt64, m.i64.and, b.i64, b.i64],
        [b.OrInt32, m.i32.or, b.i32, b.i32],
        [b.OrInt64, m.i64.or, b.i64, b.i64],
        [b.XorInt32, m.i32.xor, b.i32, b.i32],
        [b.XorInt64, m.i64.xor, b.i64, b.i64],
        [b.ShlInt32, m.i32.shl, b.i32, b.i32],
        [b.ShlInt64, m.i64.shl, b.i64, b.i64],
        [b.ShrSInt32, m.i32.shr_s, b.i32, b.i32],
        [b.ShrSInt64, m.i64.shr_s, b.i64, b.i64],
        [b.ShrUInt32, m.i32.shr_u, b.i32, b.i32],
        [b.ShrUInt64, m.i64.shr_u, b.i64, b.i64],
        [b.RotLInt32, m.i32.rotl, b.i32, b.i32],
        [b.RotLInt64, m.i64.rotl, b.i64, b.i64],
        [b.RotRInt32, m.i32.rotr, b.i32, b.i32],
        [b.RotRInt64, m.i64.rotr, b.i64, b.i64],
        [b.EqInt32, m.i32.eq, b.i32, b.i32],
        [b.EqInt64, m.i64.eq, b.i32, b.i64],
        [b.EqFloat32, m.f32.eq, b.i32, b.f32],
        [b.EqFloat64, m.f64.eq, b.i32, b.f64],
        [b.NeInt32, m.i32.ne, b.i32, b.i32],
        [b.NeInt64, m.i64.ne, b.i32, b.i64],
        [b.NeFloat32, m.f32.ne, b.i32, b.f32],
        [b.NeFloat64, m.f64.ne, b.i32, b.f64],
        [b.LtSInt32, m.i32.lt_s, b.i32, b.i32],
        [b.LtSInt64, m.i64.lt_s, b.i32, b.i64],
        [b.LtUInt32, m.i32.lt_u, b.i32, b.i32],
        [b.LtUInt64, m.i64.lt_u, b.i32, b.i64],
        [b.LtFloat32, m.f32.lt, b.i32, b.f32],
        [b.LtFloat64, m.f64.lt, b.i32, b.f64],
        [b.LeSInt32, m.i32.le_s, b.i32, b.i32],
        [b.LeSInt64, m.i64.le_s, b.i32, b.i64],
        [b.LeUInt32, m.i32.le_u, b.i32, b.i32],
        [b.LeUInt64, m.i64.le_u, b.i32, b.i64],
        [b.LeFloat32, m.f32.le, b.i32, b.f32],
        [b.LeFloat64, m.f64.le, b.i32, b.f64],
        [b.GtSInt32, m.i32.gt_s, b.i32, b.i32],
        [b.GtSInt64, m.i64.gt_s, b.i32, b.i64],
        [b.GtUInt32, m.i32.gt_u, b.i32, b.i32],
        [b.GtUInt64, m.i64.gt_u, b.i32, b.i64],
        [b.GtFloat32, m.f32.gt, b.i32, b.f32],
        [b.GtFloat64, m.f64.gt, b.i32, b.f64],
        [b.GeSInt32, m.i32.ge_s, b.i32, b.i32],
        [b.GeSInt64, m.i64.ge_s, b.i32, b.i64],
        [b.GeUInt32, m.i32.ge_u, b.i32, b.i32],
        [b.GeUInt64, m.i64.ge_u, b.i32, b.i64],
        [b.GeFloat32, m.f32.ge, b.i32, b.f32],
        [b.GeFloat64, m.f64.ge, b.i32, b.f64],
        [b.CopySignFloat32, m.f32.copysign, b.f32, b.f32],
        [b.CopySignFloat64, m.f64.copysign, b.f64, b.f64],
        [b.MinFloat32, m.f32.min, b.f32, b.f32],
        [b.MinFloat64, m.f64.min, b.f64, b.f64],
        [b.MaxFloat32, m.f32.max, b.f32, b.f32],
        [b.MaxFloat64, m.f64.max, b.f64, b.f64]
    ];
    //console.log(binaryOps);
    for (let [op, builder, result, operand] of binaryOps) {
        const name = "binary" + op;
        const params = b.createType([adapt(operand), adapt(operand)]);
        const left = m.local.get(0);
        const right = m.local.get(1);
        const body = builder(demote(left, operand), demote(right, operand));
        m.addFunction(name, params, adapt(result), [], promote(body, result));
        m.addFunctionExport(name, name);
    }
    const bytes = m.emitBinary();
    //console.log(m.emitText());

    const wasm = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(wasm, {
        env: {
            //
        }
    });
    const exports = instance.exports;

    function maxOp(list) {
        return Math.max.apply(null, list.map(([op]) => op));
    }
    function opArray(prefix, list) {
        const ops = new Array(maxOp(list));
        for (let [op] of list) {
            ops[op] = exports[prefix + op];
        }
        return ops;
    }
    return {
        binary: opArray('binary', binaryOps)
    };
}

/// Base object for the Interpreter API. Modeled after WebAssembly's base object,
/// and imports its Global, Table, and Memory classes directly for use.
/// The Module and Instance classes are custom, and can only be used via
/// async APIs.
const Interpreter = {
    // WebAssembly API clone
    Global,
    Memory,
    Table,
    Module,
    Instance,
    compile,
    compileStreaming,
    instantiate,
    instantiateStreaming,

    // Custom API
    Frame,
    isReady: false,
    ready: b.ready.then(() => {
        Interpreter.isReady = true;
        return Interpreter;
    })
};

module.exports = Interpreter;
