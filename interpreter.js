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

class Cache {
    constructor(builder) {
        this.builder = builder;
        this.map = new Map();
    }

    get(key) {
        if (this.map.has(key)) {
            return this.map.get(key);
        } else {
            const item = this.builder(key);
            this.map.set(key, item);
            return item;
        }
    }

    static make(builder) {
        const cache = new Cache(builder);
        return cache.get.bind(cache);
    }
}

const getExpressionInfo = Cache.make((expr) => {
    if (typeof expr === 'object') {
        return expr;
    }
    // Keep the reference ID on the info object as we pass it around.
    // This is a placeholder until we can retain source locations that
    // make sense (eg against the binary, or against a generated text
    // disassembly).
    const info = b.getExpressionInfo(expr);
    info.sourceLocation = String(expr);
    return info;
});

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

// returning true for the opcode itself PLUS all data inputs
// for blocks the branches/children count.
const infallible = Cache.make((expr) => {
    const info = getExpressionInfo(expr);
    switch (info.id) {
        case b.BlockId:
            return info.children.filter(infallible).length == info.children.length;
        case b.IfId:
            return infallible(info.condition) &&
                infallible(info.ifTrue) &&
                (!info.ifFalse || infallible(info.ifFalse))
        case b.LoopId:
            return infallible(info.body);
        case b.BreakId:
            return !info.value || infallible(info.value);
        case b.SwitchId:
            return (!info.value || infallible(info.value)) &&
                infallible(info.condition);
        case b.CallId:
            // @todo analyze all statically linked internal functions
            // and pass through a true if possible
        case b.CallIndirectId:
            return false;
        case b.LocalGetId:
            return true;
        case b.LocalSetId:
            return infallible(info.value);
        case b.GlobalGetId:
            return true;
        case b.GlobalSetId:
            return infallible(info.value);
        case b.LoadId:
        case b.StoreId:
            // Inherently fallible
            return false;
        case b.ConstId:
        case b.UnaryId:
            // @fixme there may be fallible unary ops like sqrt
            return true;
        case b.BinaryId:
            switch (info.op) {
                case b.DivSInt32:
                case b.DivSInt64:
                case b.DivFloat32:
                case b.DivFloat64:
                    return false;
                default:
                    return true;
            }
        case b.SelectId:
        case b.DropId:
        case b.ReturnId:
        case b.MemorySizeId:
            return true;
        case b.MemoryGrowId:
            // @fixme is this fallible or does it just return 0?
            return infallible(info.delta);
        case b.NopId:
            return true;
        case b.UnreachableId:
            // throws a runtime error on purpose :D
            return false;
        default:
            throw new Error('Invalid expression id');
    }
});

const uninterruptible = Cache.make((expr) => {
    const info = getExpressionInfo(expr);
    switch (info.id) {
        case b.BlockId:
            return info.children.filter(uninterruptible).length == info.children.length;
        case b.IfId:
            return uninterruptible(info.condition) &&
                uninterruptible(info.ifTrue) &&
                (!info.ifFalse || uninterruptible(info.ifFalse));
        case b.LoopId:
            return uninterruptible(info.body);
        case b.BreakId:
            return !info.value || uninterruptible(info.value);
        case b.SwitchId:
            return (!info.value || uninterruptible(info.value)) &&
                uninterruptible(info.condition);
        case b.CallId:
            // @todo analyze all statically linked internal functions
            // and pass through a true if possible
        case b.CallIndirectId:
            return false;
        case b.LocalGetId:
            return true;
        case b.LocalSetId:
            return uninterruptible(info.value);
        case b.GlobalGetId:
            return true;
        case b.GlobalSetId:
            return uninterruptible(info.value);
        case b.LoadId:
            // Note loads are uninterruptible but they are not infallible
            // they can throw an exception so might require a stack trace
            return uninterruptible(info.ptr);
        case b.StoreId:
            // Note stores are uninterruptible but they are not infallible
            // they can throw an exception so might require a stack trace
            return uninterruptible(info.ptr) &&
                uninterruptible(info.value);
        case b.ConstId:
            return true;
        case b.UnaryId:
            return uninterruptible(info.value);
        case b.BinaryId:
            return uninterruptible(info.left) &&
                uninterruptible(info.right);
        case b.SelectId:
            return uninterruptible(info.condition) &&
                uninterruptible(info.ifTrue) &&
                uninterruptible(info.ifFalse);
        case b.DropId:
            return uninterruptible(info.value);
        case b.ReturnId:
            return !info.value || uninterruptible(info.value);
        case b.MemorySizeId:
            return true;
        case b.MemoryGrowId:
            return uninterruptible(info.delta);
        case b.NopId:
        case b.UnreachableId:
            return false;
        default:
            throw new Error('Invalid expression id');
    }
});

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

let letters = Array.from(range(26)).map((n) => String.fromCharCode(n + "a".charCodeAt(0)));
function letter(n) {
    let suffix = '';
    do {
        suffix = letters[n % 26] + suffix;
        n = Math.trunc(n / 26);
    } while (n > 0);
    return suffix;
}

class Stack {
    constructor() {
        this.items = [];
        this.maxDepth = 0;
    }

    get depth() {
        return this.items.length;
    }

    get current() {
        if (this.depth == 0) {
            throw new RangeError('empty stack');
        }
        return this.items[this.depth - 1];
    }

    get(index) {
        if (index < 0) {
            index = this.depth + index;
        }
        const u32 = index >>> 0;
        if (u32 >= this.depth || u32 !== index) {
            throw new RangeError('invalid index');
        }
        return this.items[u32];
    }

    push(val) {
        const depth = this.items.push(val);
        if (depth > this.maxDepth) {
            this.maxDepth = depth;
        }
        return depth;
    }

    pop() {
        if (this.depth == 0) {
            throw new RangeError('empty stack');
        }
        return this.items.pop();
    }

    block(val, callback) {
        this.push(val);
        try {
            return callback();
        } finally {
            this.pop();
        }
    }

    find(callback) {
        return this.items.find(callback);
    }
}

class Compiler {
    constructor(instance, params=[], vars=[]) {
        this.instance = instance;
        this.paramTypes = params.slice();
        this.localDefaults = params.concat(vars).map(defaultValue);
        this.closure = [];
        this.closureMap = Cache.make((val) => {
            const index = this.closure.push(val) - 1;
            return 'closure' + index;
        });
        this.labels = [];
        this.sources = [];
        this.stack = new Stack();
        this.optimizedVars = new Map();
        this.expressions = new Stack();
        this.optimizedStack = new Stack();
        this.tempVars = new Stack();
        this.blocks = new Stack();
        this.loops = 0;
    }

    static compileBase(instance, expr, params, results, vars, name='<anonymous>') {
        const compiler = new Compiler(instance, params, vars);
        const inst = compiler.enclose(instance);
        const paramNames = params.map((_type, index) => `param${index}`);
        const {
            body,
            result,
            optimizedResult
        } = compiler.flatten(compiler.compile(expr));
        const hasResult = (results !== b.none);
        const maxDepth = compiler.stack.maxDepth;
        console.log({body, result});
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
                    maxDepth
                    ? `let ${compiler.stackVars(maxDepth).join(`, `)};`
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
                        Array.from(range(maxDepth + 1), (_, depth) => {
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
                // @fixme do this thorugh the exception after all
                instance._stackTracers.push(dump);
                try {
                    ${body}
                    ${hasResult ? `return ${result};` : ``}
                } finally {
                    instance._stackTracers.pop();
                }
            };
        `;
        const closureNames = compiler.closure.map((val) => compiler.enclose(val));
        const args = closureNames.concat([func]);
        console.log(func);
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
        const cleanPath = (node) => {
            if (node.infallible) {
                return `/* infallible */ ${node.optimized}`;
            } else if (node.uninterruptible) {
                return `/* uninterruptible */ ${node.optimized}`;
            } else {
                return `/* spill */ ${node.spill} ${node.optimized}`;
            }
        };
        const dirtyPath = (node) => {
            return `${node.infallible ? `` : node.spill}
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
        };
        const collapse = (nodes, callback) => {
            if (nodes.length == 0) {
                return `/* empty block */`;
            }
            return nodes.map(callback).join('\n');
        };
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
                    ${collapse(nodes, dirtyPath)}
                } else {
                    ${collapse(nodes, cleanPath)}
                }
            `;
        };
        const last = nodes.length ? nodes[nodes.length - 1] : null;
        const result = last ? last.result : null;
        const optimizedResult = last ? last.optimizedResult : null;
        console.log({
            result,
            nodes: nodes.map((node) => node)
        })
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
            console.log('DIRTY THE RESULT IS', result);
            return {
                body: source,
                result,
                optimizedResult
            };
        } else {
            console.log('CLEAN THE RESULT IS', result);
            return {
                body: nodes.map(cleanPath).join('\n'),
                result,
                optimizedResult
            };
        }
    }

    enclose(value) {
        // @fixme replace all of these with
        // source-compilation-friendly references
        return this.closureMap(value);
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
        if (name) {
            let index = this.labels.indexOf(name);
            if (index === -1) {
                index = this.labels.push(name) - 1;
            }
            return 'label' + index;
        }
        return null;
    }

    outerLoop() {
        return `loop${this.loops++}`;
    }

    labelDecl(block) {
        return block.label ? `${block.label}:` : ``;
    }

    block(result, name, callback) {
        const label = this.label(name);
        const temp = this.temp(result);
        const block = {
            result,
            name,
            label,
            temp
        };
        this.blocks.push(block);
        const prefix = this.declareTemp(block);
        const content = callback(block);
        const suffix = this.pushTemp(block);
        if (block.result) {
            // must be stored via stashTemp first!
            this.pop();
        }

        return [prefix, content, suffix].join('\n');
    }

    findBlock(name) {
        return this.blocks.find((block) => block.name === name);
    }

    break(name) {
        const block = this.findBlock(name);
        return `
            ${this.stashTemp(block)}
            break ${block.label};
        `;
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
            node.depth = this.literal(this.stack.depth);
        }
        return `
                node = ${this.enclose(node)};
        `;
    }

    opcode(expr, args, builder) {
        const spill = this.spill(expr);

        return this.expressions.block(expr, () => {
            // Note we use 'args' for block children which
            // may or may not have return values, so we have
            // to check them all.
            const build = () => {
                const nodes = [];
                let inputs = 0;
                for (let arg of args) {
                    const argNodes = this.compile(arg);
                    nodes.push(...argNodes);
                    if (getExpressionInfo(arg).type != b.none) {
                        inputs++;
                    }
                }
                const stackVars = [];
                for (let _i of range(inputs)) {
                    stackVars.unshift(this.pop());
                }
    
                let result = null, resultDecl = null;
                if (expr.type != b.none) {
                    // Get the stack variable name for the value pushed by the opcode
                    resultDecl = this.pushVar(expr);
                    result = this.peek();
                }
                let fragment = builder(resultDecl, ...stackVars);
                nodes.push({
                    stackDepth: this.stack.depth,
                    result,
                    resultDecl,
                    sourceLocation: expr.sourceLocation,
                    uninterruptible: uninterruptible(expr),
                    infallible: infallible(expr),
                    fragment,
                    memory: memoryExpression(expr),
                    spill
                });
                return nodes;
            };

            // Run everything in de-opt
            const nodes = this.optimizedStack.block(false, build);

            // and also in opt mode
            if (expr.type != b.none) {
                // Hack to get the result var off the stack
                // without polluting state
                this.stack.pop();
            }

            const opt = this.optimizedStack.block(true, build);
            nodes.forEach((node, index) => {
                node.optimized = opt[index].fragment
                node.optimizedResult = opt[index].result
            });

            return nodes;
    });
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

    optimizeVar(name, expr) {
        //console.log({variant: {expr, name}});
        let variants;
        if (this.optimizedVars.has(name)) {
            variants = this.optimizedVars.get(name);
        } else {
            variants = new Map();
            this.optimizedVars.set(name, variants);
        }
        if (variants.has(expr.sourceLocation)) {
            return variants.get(expr.sourceLocation);
        }
        const index = variants.size;
        const suffix = letter(index);
        const opt = `${name}${suffix}`;
        //console.log(`creating var ${opt}`, expr);
        variants.set(expr.sourceLocation, opt);
        return opt;
    }

    optimizeMode() {
        return this.optimizedStack.current;
    }

    canOptimizeResult() {
        if (!this.instance._debug) {
            // Always optimize if compiling with debug off
            return true;
        }
        if (!this.optimizeMode()) {
            console.log('not optimize mode')
            // Never optimize in the debug-mode path
            return false;
        }
        if (this.expressions.depth == 0) {
            console.log('no expressions')
            // No remaining consumer expression
            return false;
        }
        // If the consumer of the result is infallible, they
        // won't need to dump our data on a stacktrace.
        if (infallible(this.expressions.get(-1))) {
            console.log('parent infallible');
            return true;
        }
        console.log('parent not infallible');
        return false;
    }

    pushVar(expr) {
        const index = this.stack.depth;
        const name = `stack${index}`;

        if (this.canOptimizeResult()) {
            const opt = this.optimizeVar(name, expr);
            this.stack.push(opt);
            return `const ${opt}`;
        } else {
            this.stack.push(name);
            return `${name}`;
        }
    }

    pop() {
        return this.stack.pop();
    }

    peek() {
        return this.stack.current;
    }

    temp(type) {
        if (type) {
            const index = this.tempVars.depth;
            const name = `temp${index}`;
            this.tempVars.push(name);
            return name;
        }
        return null;
    }

    declareTemp(block) {
        if (block.temp) {
            return `let ${block.temp};`;
        }
        return ``;
    }

    pushTemp(block) {
        if (block.result) {
            return `/* pushTemp */ ${block.result} = ${block.temp};`;
        }
        return ``;
    }

    stashTemp(block) {
        if (block.temp) {
            return `/* stashTemp */ ${block.temp} = ${this.peek()};`
        }
        return ``;
    }

    _compileBlock(expr) {
        return this.opcode(expr, [], (result) =>
            this.block(result, expr.name, (block) => `
                ${this.labelDecl(block)}
                {
                    ${this.flatten(
                        expr.children.flatMap((expr) => this.compile(expr))
                    ).body}
                    ${this.stashTemp(block)}
                }
            `)
        );
    }

    _compileIf(expr) {
        return this.opcode(expr, [expr.condition], (result, condition) =>
            this.block(result, null, (block) => `
                if (${condition}) {
                    ${this.flatten(this.compile(expr.ifTrue)).body}
                    ${this.stashTemp(block)}
                } ${expr.ifFalse ? `else {
                    ${this.flatten(this.compile(expr.ifFalse)).body}
                    ${this.stashTemp(block)}
                }` : ``}
            `)
        );
    }

    _compileLoop(expr) {
        const outer = this.outerLoop();
        return this.opcode(expr, [], (result) =>
            this.block(result, expr.name, (block) => `
                ${outer}:
                for (;;) {
                    ${this.labelDecl(block)}
                    {
                        ${this.flatten(this.compile(expr.body)).body}
                        ${this.stashTemp(block)}
                        break ${outer};
                    }
                }
            `)
        );
    }

    _compileBreak(expr) {
        if (expr.condition) {
            return this.opcode(expr, [expr.condition], (_result, condition) => `
                if (${condition}) {
                    ${this.break(expr.name)}
                }
            `);
        } else {
            return this.opcode(expr, [], (_result) =>
                this.break(expr.name)
            );
        }
    }

    _compileSwitch(expr) {
        return this.opcode(expr, [expr.condition], (_result, condition) => `
            switch (${condition}) {
                ${expr.names.map((name, index) => `
                    case ${index}:
                        ${this.break(name)}
                `).join('\n')}
                default:
                    ${this.break(expr.defaultName)}
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
        if (expr.isTee) {
            return this.opcode(expr, [expr.value], (result, value) => `
                ${result} = ${this.local(expr.index)} = ${value};
            `);
        }
        return this.opcode(expr, [expr.value], (_result, value) => `
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
                return `Math.fround(${left} + ${right})`;
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
                return `Math.fround(${left} * ${right})`;
            case b.MulFloat64:
                return `${left} * ${right}`;

            case b.DivSInt32:
                return `(${left} / ${right}) | 0`;
            case b.DivSInt64:
                return `${left} / ${right}`;
            case b.DivUInt32:
                return `((${left} >>> 0) / (${right} >>> 0)) | 0`;
            case b.DivUInt64:
                return `BigInt.asIntN(BigInt.asUintN(64, ${left}) / BigInt.asUintN(64, ${right}))`;
            case b.DivFloat32:
                return `Math.fround(${left} / ${right})`;
            case b.DivFloat64:
                return `${left} / ${right}`;

            case b.RemSInt32:
                return `(${left} % ${right}) | 0`;
            case b.RemSInt64:
                return `${left} % ${right}`;
            case b.RemUInt32:
                return `((${left} >>> 0) % (${right} >>> 0)) | 0`;
            case b.RemUInt64:
                return `BigInt.asIntN(BigInt.asUintN(64, ${left}) % BigInt.asUintN(64, ${right}))`;

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
            case b.ShrSInt64:
                return `${left} >> (${right} & 63n)`;
            case b.ShrUInt32:
                return `(${left} >>> ${right}) | 0`;
            case b.ShrUInt64:
                return `BigInt.asIntN(64, BigInt.asUintN(64, ${left}) >> (${right} & 63n)))`;

            case b.RotLInt32:
                // https://en.wikipedia.org/wiki/Circular_shift#Implementing_circular_shifts
                return `${left} << (${right} & 31) | ${left} >> (32 - (${right} & 31))`;
            case b.RotLInt64:
                return `BigInt.asIntN(64, ${left} << (${right} & 63n) | ${left} >> (64n - (${right} & 63n)))`;
            case b.RotRInt32:
                return `${left} >> (${right} & 31) | ${left} << (32 - (${right} & 31))`;
            case b.RotRInt64:
                return `BigInt.asIntN(64, ${left} >> (${right} & 63n) | ${left} << (64n - (${right} & 63n)))`;

            case b.EqInt32:
            case b.EqInt64:
                return `(${left} === ${right}) | 0`;
            case b.EqFloat32:
            case b.EqFloat64:
                // @todo double-check this is the right comparison for floats
                // This will return true for comparing two NaNs
                // and false for comparing -0 and +0
                // whereas using === would do the opposite for these cases.
                return `Object.is(${left}, ${right}) | 0`;

            case b.NeInt32:
            case b.NeInt64:
                return `(${left} !== ${right}) | 0`;
            case b.NeFloat32:
            case b.NeFloat64:
                // @todo double-check this is the right comparison for floats
                // This will return false for comparing two NaNs
                // and true for comparing -0 and +0
                // whereas using !== would do the opposite for these cases.
                return `!Object.is(${left}, ${right}) | 0`;

            case b.LtSInt32:
            case b.LtSInt64:
            case b.LtFloat32:
            case b.LtFloat64:
                return `(${left} < ${right}) | 0`;
            case b.LtUInt32:
                return `((${left} >>> 0) < (${right} >>> 0)) | 0`;
            case b.LtUInt64:
                return `(BigInt.asUintN(64, ${left}) < BigInt.asUintN(64, ${right})) | 0`;

            case b.LeSInt32:
            case b.LeSInt64:
            case b.LeFloat32:
            case b.LeFloat64:
                return `(${left} <= ${right}) | 0`;
            case b.LeUInt32:
                return `((${left} >>> 0) <= (${right} >>> 0)) | 0`;
            case b.LeUInt64:
                return `(BigInt.asUintN(64, ${left}) <= BigInt.asUintN(64, ${right})) | 0`;
        
            case b.GtSInt32:
            case b.GtFloat32:
            case b.GtFloat64:
                return `(${left} > ${right}) | 0`;
            case b.GtUInt32:
                return `((${left} >>> 0) > (${right} >>> 0)) | 0`;
            case b.GtUInt64:
                return `(BigInt.asUintN(64, ${left}) > BigInt.asUintN(64, ${right})) | 0`;
        
            case b.GeSInt32:
            case b.GeFloat32:
            case b.GeFloat64:
                return `(${left} >= ${right}) | 0`;
            case b.GeUInt32:
                return `((${left} >>> 0) >= (${right} >>> 0)) | 0`;
            case b.GeUInt64:
                return `(BigInt.asUintN(64, ${left}) >= BigInt.asUintN(64, ${right})) | 0`;

            case b.CopySignFloat32:
                {
                    const view = this.enclose(reinterpretView);
                    return `/* copysign */
                        ${view}.setFloat32(0, ${operand}, true),
                        ${view}.setInt32(0, ${view}.getInt32(0, true) | 0x80000000, true),
                        ${view}.getFloat32(0, true)
                    `;
                }
            case b.CopySignFloat64:
                {
                    const view = this.enclose(reinterpretView);
                    return `/* copysign */
                        ${view}.setFloat64(0, ${operand}, true),
                        ${view}.setInt32(4, ${view}.getInt32(4, true) | 0x80000000, true),
                        ${view}.getFloat64(0, true)
                    `;
                }
    
            case b.MinFloat32:
            case b.MinFloat64:
                return `Math.min(${left}, ${right})`;
            case b.MaxFloat32:
            case b.MaxFloat64:
                return `Math.max(${left}, ${right})`;

            default:
                throw new Error('Unknown binary op');
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
