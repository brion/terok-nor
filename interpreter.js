const binaryen = require('binaryen');
const b = binaryen;

const Global = WebAssembly.Global;
const Memory = WebAssembly.Memory;

/// Clone of WebAssembly.Table that lets us store JS async functions
class Table {
    constructor({element, initial, maximum=undefined}) {
        if (element !== 'anyfunc') {
            throw new TypeError('Interpreter only supports anyfunc tables');
        }
        if (initial !== (initial | 0)) {
            console.log({initial});
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
    constructor(bufferSource) {
        this._mod = null;

        let input = normalizeBuffer(bufferSource);
        if (!b.isReady) {
            // copy in case the array changes later
            input = input.slice();
        }

        this.isReady = false;
        this.ready = b.ready.then(async () => {
            this._mod = b.readBinary(input);
            this.isReady = true;
            return this;
        });
    }
}

class Instance {
    constructor(module, imports) {
        this.exports = {};

        this._mod = module._mod;
        this._globals = {};
        this._funcs = {};

        // @todo support multiples
        this._memory = null;
        this._table = null;

        this._ops = null;

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
                const numSegments = mod.getNumMemorySegments();
                for (let i = 0; i < numSegments; i++) {
                    const segment = mod.getMemorySegmentInfoByIndex(i);
                    if (!segment.passive) {
                        const offset = await evaluateConstant(segment.offset);

                        let heap = new Uint8Array(this.memory.buffer);
                        const headroom = heap.length - (offset + segment.data.length);
                        if (headroom < 0) {
                            this._memory.grow(Math.ceil(headroom / 65536));
                            heap = new Uint8Array(this._memory.buffer);
                        }

                        heap.set(offset, segment.data);
                    }
                }
            } else {
                throw new Error('Currently requires a memory');
            }

            // Now that we have memory, create the ops module
            // This implements unary, binary, and load/store ops via sync WebAssembly
            this._ops = buildOpsModule(this._memory);

            const evaluateConstant = async (expr) => {
                const frame = new Frame(this);
                const executor = frame.compile(expr);
                return frame.evaluate(executor);
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
                    thunk = async (...args) => {
                        const frame = new Frame(this, func, args);
                        return await frame.run();
                    };
                } else {
                    // Imports; note import functions may be sync or async.
                    const imported = imports[func.module][func.base];
                    if (imported instanceof Function) {
                        thunk = async (...args) => {
                            return await imported(...args);
                        };
                    } else {
                        throw new RangeError("Expected function for import");
                    }
                }
                this._funcs[func.name] = thunk;
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

}

/// Parse a module from binary form and prepare it to be instantiated later.
/// Currently this compilation is done synchronously on the main thread,
/// but please use this async API for future-proofing.
async function compile(bufferSource) {
    const module = new Module(bufferSource);
    return await module.ready;
}

/// Parse a module from a stream containing binary form and prepare it to be
/// instantiated later. Currently this compilation is done synchronously on
/// the main thread after the whole stream is collected in memory, but please
/// use this async API for future-proofing.
async function compileStreaming(source) {
    const response = await source;
    const buffer = await response.arrayBuffer();
    const module = new Module(buffer);
    return await module.ready;
}

/// Parse/compile and instantiate from a buffer
async function instantiate(bufferSource, importObject) {
    const module = await compile(bufferSource);
    const instance = new Instance(module, importObject);
    await instance.ready;
    return {
        module,
        instance
    };
}

/// Parse/compile and instantiate from a Response or Promise<Response>
async function instantiateStreaming(source, importObject) {
    const module = await compileStreaming(source);
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
            return value | 0;
        case b.i64:
            return BigInt.asIntN(64, BigInt(value));
        case b.f32:
            return Math.fround(value);
        case b.f64:
            return +value;
        default:
            // Assume others are reference types?
            return value;
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


class LabelEscape extends Error {
    constructor(stack, name) {
        super("WebAssembly interpreter escape", "n/a", "n/a");
        this.stack = stack;
        this.name = name;
    }
}

const ReturnLabel = Symbol("ReturnLabel");

class Stack {
    constructor() {
        this.values = [];
    }

    get length() {
        return this.values.length;
    }

    push(value) {
        this.values.push(value);
    }

    pop() {
        if (this.values.length) {
            return this.values.pop();
        } else {
            throw new RangeError('stack underflow');
        }
    }

    save() {
        return this.values.length;
    }

    restore(saved, preserve=0) {
        this.values.splice(saved, (this.save() - saved) - preserve);        
    }

    async block(name, resultCount, callback) {
        const saved = this.save();
        try {
            await callback();
            return;
        } catch (e) {
            if (e instanceof LabelEscape && e.stack === this && e.name === name) {
                this.restore(saved, resultCount);
            } else {
                throw e;
            }
        }
    }

    async loop(name, resultCount, callback) {
        const saved = this.save();
        while (true) {
            try {
                await callback();
                // This will return after one iteration unless something branches back to us.
                return;
            } catch (e) {
                if (e instanceof LabelEscape && e.stack === this && e.name === name) {
                    // @fixme unsure of the resultCount behavior here
                    this.restore(saved, resultCount);
                    // Don't return from the loop -- let it go round for another pass.
                } else {
                    throw e;
                }
            }
        }
    }

    escape(name) {
        throw new LabelEscape(this, name);
    }

    rollup() {
        const len = this.length;
        if (len == 0) {
            return;
        } else if (len == 1) {
            return this.pop();
        } else {
            const values = new Array(len);
            for (let i = len - 1; i >= 0; i--) {
                values[i] = this.pop();
            }
            return values;
        }
    }
}

/// Execution state frame for a single function
///
/// Will run asynchronously, but is *not* safe for re-entrant calls
/// during a single execution run.
///
/// Not meant to be exposed externally.
class Frame {
    constructor(instance, func=null, args=[]) {
        this._instance = instance;
        this._ops = instance._ops;
        this._func = func;

        if (func) {
            // Reserve space for arguments and locals
            const params = b.expandType(func.params).filter(b.expandType);
            this._params = params;

            this.locals = params.concat(func.vars).filter(defaultValue);
            for (let i = 0; i < params.length; i++) {
                this.locals[i] = coerceValue(params[i], args[i]);
            }
        } else {
            // Constant evaluation, no function state
            this._params = [];
            this.locals = [];
        }

        this.stack = new Stack();
    }

    /// Run a function to completion.
    /// Not applicable when used for constant evaluation.
    async run() {
        // @todo cache the compiled executor tree
        const executor = this.compile(this._func.body);
        await this.stack.block(ReturnLabel, this._func.params.length, async () => {
            await executor();
        });
        return this.stack.rollup();
    }

    /// Compile a single expression from the AST into an async function
    compile(expression) {
        if (!expression) {
            throw new Error('where am i');
        }
        const expr = b.getExpressionInfo(expression);
        const handler = expressionMap(expr.id);
        if (this[handler]) {
            return this[handler](expr);
        } else {
            throw new RangeError("Cannot compile unknown expression");
        }
    }

    compileMultiple(expressions) {
        return expressions.map((expression) => this.compile(expression));
    }

    /// Evaluate a single expression and return its result off the stack.
    async evaluate(executor) {
        await executor();
        const value = this.stack.pop();
        return value;
    }

    /// Evaluate multiple expressions from the AST and return their results as an array.
    /// @fixme is this necessary? is there a better way to do this that's async-friendly?
    async evaluateMultiple(executors) {
        const vals = [];
        for (let executor of executors) {
            vals.push(await this.evaluate(executor));
        }
        return vals;
    }

    _compileBlock(expr) {
        const name = expr.name;
        const results = resultCount(expr.type);
        const children = this.compileMultiple(expr.children);
        return async () => {
            await this.stack.block(name, results, async () => {
                for (let child of children) {
                    await child();
                }
            });
        };
    }

    _compileIf(expr) {
        const cond = this.compile(expr.condition);
        const ifTrue = this.compile(expr.ifTrue);
        const ifFalse = expr.ifFalse ? this.compile(expr.ifFalse) : null;
        return async() => {
            if (await this.evaluate(cond)) {
                await ifTrue();
            } else if (ifFalse) {
                await ifFalse();
            }
        }
    }

    _compileLoop(expr) {
        const name = expr.name;
        const results = resultCount(expr.type);
        const body = this.compile(expr.body);
        return async () => {
            await this.stack.loop(name, results, async () => {
                await body();
            });
        };
    }

    _compileBreak(expr) {
        const name = expr.name;
        if (expr.conditional) {
            const cond = this.compile(expr.conditional);
            return async () => {
                if (await this.evaluate(cond)) {
                    this.stack.escape(name);
                }
            };
        }
        return async () => {
            this.stack.escape(name);
        };
    }

    _compileSwitch(expr) {
        const conditional = this.compile(expr.conditional);
        const names = expr.names;
        const defaultName = expr.defaultName;
        return async () => {
            const index = await this.evaluate(conditional);
            if (names[index]) {
                this.stack.escape(names[index]);
            } else {
                this.stack.escape(defaultName);
            }
        };
    }

    _compileCall(expr) {
        const operands = this.compileMultiple(expr.operands);
        const func = this._instance._funcs[expr.target];
        const hasResult = (expr.type !== b.none);

        return async () => {
            // @todo store frames on a module-global stack?
            const args = await this.evaluateMultiple(operands);
            const result = await func(...args);

            // @todo may need to support multiple returns later
            if (hasResult) {
                this.stack.push(result);
            }
        };
    }

    _compileCallIndirect(expr) {
        const operands = this.compileMultiple(expr.operands);
        const target = this.compile(expr.target);
        const hasResult = (expr.type !== b.none);

        return async () => {
            const index = await this.evaluate(target);
            const func = this._instance._table.get(index);

            // @todo enforce signature matches
    
            // @todo store frames on a module-global stack?
            const args = await this.evaluateMultiple(operands);
            const result = await func(...args);
    
            // @todo may need to support multiple returns later
            if (hasResult) {
                this.stack.push(result);
            }
        };
    }

    _compileLocalGet(expr) {
        const index = expr.index;
        return async () => {
            const value = this.locals[index];
            this.stack.push(value);
        };
    }

    _compileLocalSet(expr) {
        const valueExpr = this.compile(expr.value);
        const isTee = expr.isTee;
        return async () => {
            const value = await this.evaluate(valueExpr);
            this.locals[index] = value;
            if (isTee) {
                this.stack.push(value);
            }
        };
    }

    _compileGlobalGet(expr) {
        const global = this._instance._globals[expr.name];
        return async () => {
            const value = global.value;
            this.stack.push(value);
        };
    }

    _compileGlobalSet(expr) {
        const global = this._instance._globals[expr.name];
        const valueExpr = this.compile(expr.value);
        return async () => {
            const value = await this.evaluate(valueExpr);
            global.value = value;
        };
    }

    _compileLoad(expr) {
        const ptrExpr = this.compile(expr.ptr);
        const offset = expr.offset;
        const func = this._ops.memory.load[expr.type][expr.bytes << 3][expr.isSigned ? 'signed' : 'unsigned'];
        return async () => {
            const ptr = await this.evaluate(ptrExpr);
            const value = func(ptr + offset);
            this.stack.push(value);
        };
    }

    _compileStore(expr) {
        const ptrExpr = this.compile(expr.ptr);
        const offset = expr.offset;
        const valueExpr = this.compile(expr.value);
        const valueInfo = b.getExpressionInfo(expr.value);
        const func = this._ops.memory.store[valueInfo.type][expr.bytes << 3];
        return async () => {
            const ptr = await this.evaluate(ptrExpr);
            const value = await this.evaluate(valueExpr);
            func(ptr + offset, value);
        };
    }

    _compileConst(expr) {
        let value;
        if (expr.type == b.i64) {
            const {high, low} = expr.value;
            value = (BigInt(high | 0) << 32n) | BigInt(low >>> 0);
        } else {
            value = expr.value;
        }
        return async() => {
            this.stack.push(value);
        };
    }

    _compileUnary(expr) {
        const valueExpr = this.compile(expr.value);
        const func = this._ops.unary[expr.id];
        return async () => {
            const value = await this.evaluate(valueExpr);
            const result = func(value);
            this.stack.push(result);
        };
    }

    _compileBinary(expr) {
        const leftExpr = this.compile(expr.left);
        const rightExpr = this.compile(expr.right);
        const func = this._ops.binary[expr.id];
        return async () => {
            const left = await this.evaluate(leftExpr);
            const right = await this.evaluate(rightExpr);
            const result = func(left, right);
            this.stack.push(result);
        };
    }

    _compileSelect(expr) {
        const ifTrueExpr = this.compile(expr.ifTrue);
        const ifFalseExpr = this.compile(expr.ifFalse);
        const condExpr = this.compile(expr.condition);
        return async () => {
            const ifTrue = await this.evaluate(ifTrueExpr);
            const ifFalse = await this.evaluate(ifFalseExpr);
            const cond = await this.evaluate(condExpr);
            this.stack.push(cond ? ifTrue : ifFalse);
        };
    }

    _compileDrop(expr) {
        const valueExpr = this.compile(expr.value);
        return async () => {
            await this.evaluate(valueExpr);
        };
    }

    _compileMemorySize(expr) {
        return async () => {
            this.stack.push(this._instance._memory.buffer.length / 65536);
        };
    }

    _compileMemoryGrow(expr) {
        const deltaExpr = this.compile(expr.delta);
        return async () => {
            const delta = await this.evaluate(deltaExpr);
            const result = this._instance._memory.grow(delta);
            this.stack.push(result);
        };
    }

    _compileReturn(expr) {
        const valueExpr = expr.value ? this.compile(expr.value) : null;
        return async () => {
            if (valueExpr) {
                await valueExpr();
            }
            this.stack.escape(ReturnLabel);
        };
    }

    _compileNop(expr) {
        return async () => {
            // do nothing
        };
    }

    _compileUnreachable(expr) {
        return async () => {
            throw new WebAssembly.RuntimeError("Unreachable code");
        };
    }
}

function buildOpsModule(memory) {
    const m = b.parseText("(module)");
    m.addMemoryImport("memory", "env", "memory");

    const unaryOps = [
        [b.ClzInt32, m.i32.clz, b.i32, b.i32],
        [b.ClzInt64, m.i64.clz, b.i64, b.i64],
        [b.CtzInt32, m.i32.ctz, b.i32, b.i32],
        [b.CtzInt64, m.i64.ctz, b.i64, b.i64],
        [b.PopcntInt32, m.i32.popcnt, b.i32, b.i32],
        [b.PopcntInt64, m.i64.popcnt, b.i64, b.i64],
    
        [b.NegFloat32, m.f32.neg, b.f32, b.f32],
        [b.NegFloat64, m.f64.neg, b.f64, b.f64],
        [b.AbsFloat32, m.f32.abs, b.f32, b.f32],
        [b.AbsFloat64, m.f64.abs, b.f64, b.f64],
        [b.CeilFloat32, m.f32.ceil, b.f32, b.f32],
        [b.CeilFloat64, m.f64.ceil, b.f64, b.f64],
        [b.FloorFloat32, m.f32.floor, b.f32, b.f32],
        [b.FloorFloat64, m.f64.floor, b.f64, b.f64],
        [b.TruncFloat32, m.f32.trunc, b.f32, b.f32],
        [b.TruncFloat64, m.f64.trunc, b.f64, b.f64],
        [b.NearestFloat32, m.f32.nearest, b.f32, b.f32],
        [b.NearestFloat64, m.f64.nearest, b.f64, b.f64],
        [b.SqrtFloat32, m.f32.sqrt, b.f32, b.f32],
        [b.SqrtFloat64, m.f64.sqrt, b.f64, b.f64],
    
        [b.EqZInt32, m.i32.eqz, b.i32, b.i32],
        [b.EqZInt64, m.i64.eqz, b.i32, b.i64],
    
        [b.TruncSFloat32ToInt32, m.i32.trunc_s.f32, b.i32, b.f32],
        [b.TruncSFloat64ToInt32, m.i32.trunc_s.f64, b.i32, b.f64],
        [b.TruncUFloat32ToInt32, m.i32.trunc_u.f32, b.i32, b.f32],
        [b.TruncUFloat64ToInt32, m.i32.trunc_u.f64, b.i32, b.f64],
        [b.TruncSFloat32ToInt64, m.i64.trunc_s.f32, b.i64, b.f32],
        [b.TruncSFloat64ToInt64, m.i64.trunc_s.f64, b.i64, b.f64],
        [b.TruncUFloat32ToInt64, m.i64.trunc_u.f32, b.i64, b.f32],
        [b.TruncUFloat64ToInt64, m.i64.trunc_u.f64, b.i64, b.f64],
    
        [b.ReinterpretFloat32, m.i32.reinterpret, b.i32, b.f32],
        [b.ReinterpretFloat64, m.i64.reinterpret, b.i64, b.f64],
    
        [b.ConvertSInt32ToFloat32, m.f32.convert_s.i32, b.f32, b.i32],
        [b.ConvertSInt32ToFloat64, m.f64.convert_s.i32, b.f64, b.i32],
        [b.ConvertUInt32ToFloat32, m.f32.convert_u.i32, b.f32, b.i32],
        [b.ConvertUInt32ToFloat64, m.f64.convert_u.i32, b.f64, b.i32],
        [b.ConvertSInt64ToFloat32, m.f32.convert_s.i64, b.f32, b.i64],
        [b.ConvertSInt64ToFloat64, m.f64.convert_s.i64, b.f64, b.i64],
        [b.ConvertUInt64ToFloat32, m.f32.convert_u.i64, b.f32, b.i64],
        [b.ConvertUInt64ToFloat64, m.f64.convert_u.i64, b.f64, b.i64],
    
        [b.PromoteFloat32, m.f64.promote, b.f64, b.f32],
        [b.DemoteFloat64, m.f32.demote, b.f32, b.f64],
        [b.ReinterpretInt32, m.f32.reinterpret, b.f32, b.i32],
        [b.ReinterpretInt64, m.f64.reinterpret, b.f64, b.i64]
    ];
    for (let [op, builder, result, operand] of unaryOps) {
        const name = "unary" + op;
        const params = b.createType([operand]);
        const arg = m.local.get(0);
        const body = builder(arg);
        m.addFunction(name, params, result, [], body);
        m.addFunctionExport(name, name);
    }

    const binaryOps = [
        [b.AddInt32, m.i32.add, b.i32, b.i32],
        [b.AddInt64, m.i64.add, b.i64, b.i64],
        [b.SubInt32, m.i32.sub, b.i32, b.i32],
        [b.SubInt64, m.i64.sub, b.i64, b.i64],
        [b.MulInt32, m.i32.mul, b.i32, b.i32],
        [b.MulInt64, m.i64.mul, b.i64, b.i64],
        [b.DivSInt32, m.i32.div_s, b.i32, b.i32],
        [b.DivSInt64, m.i64.div_s, b.i64, b.i64],
        [b.DivUInt32, m.i32.div_u, b.i32, b.i32],
        [b.DivUInt64, m.i64.div_u, b.i64, b.i64],
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
    for (let [op, builder, result, operand] of binaryOps) {
        const name = "binary" + op;
        const params = b.createType([operand, operand]);
        const left = m.local.get(0);
        const right = m.local.get(1);
        const body = builder(left, right);
        m.addFunction(name, params, result, [], body);
        m.addFunctionExport(name, name);
    }

    const loadOps = [
        ['i32_load8_s', m.i32.load8_s, b.i32],
        ['i32_load8_u', m.i32.load8_u, b.i32],
        ['i32_load16_s', m.i32.load16_s, b.i32],
        ['i32_load16_u', m.i32.load16_u, b.i32],
        ['i32_load', m.i32.load, b.i32],
        ['i64_load8_s', m.i64.load8_s, b.i64],
        ['i64_load8_u', m.i64.load8_u, b.i64],
        ['i64_load16_s', m.i64.load16_s, b.i64],
        ['i64_load16_u', m.i64.load16_u, b.i64],
        ['i64_load32_s', m.i64.load32_s, b.i64],
        ['i64_load32_u', m.i64.load32_u, b.i64],
        ['i64_load', m.i64.load, b.i64]
    ];
    for (let [name, builder, result] of loadOps) {
        const params = b.createType([b.i32]);
        const arg = m.local.get(0);
        const body = builder(0, 1, arg);
        m.addFunction(name, params, result, [], body);
        m.addFunctionExport(name, name);
    }

    const storeOps = [
        ['i32_store8', m.i32.store8, b.i32],
        ['i32_store16', m.i32.store16, b.i32],
        ['i32_store', m.i32.store, b.i32],
        ['i64_store8', m.i64.store8, b.i64],
        ['i64_store16', m.i64.store16, b.i64],
        ['i64_store32', m.i64.store32, b.i64],
        ['i64_store', m.i64.store, b.i64]
    ];
    for (let [name, builder, operand] of storeOps) {
        const params = b.createType([b.i32, operand]);
        const ptr = m.local.get(0);
        const value = m.local.get(1);
        const body = builder(0, 1, ptr, value);
        m.addFunction(name, params, b.none, [], body);
        m.addFunctionExport(name, name);
    }

    const bytes = m.emitBinary();
    const wasm = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(wasm, {
        env: {
            memory
        }
    });

    function maxOp(list) {
        return Math.max.apply(null, list.map(([op]) => op));
    }
    function opArray(prefix, list) {
        let ops = new Array(maxOp(unaryOps));
        for (let [op] of list) {
            ops[op] = instance.exports[prefix + op];
        }
    }
    return {
        unary: opArray('unary', unaryOps),
        binary: opArray('binary', binaryOps),
        memory: buildMemoryOps(instance.exports)
    };
}

function buildMemoryOps(ops) {
    const map = {};
    const subops = ['load', 'store'];
    for (let op of subops) {
        const opMap = {};
        opMap[b.i32] = buildMemoryOpsMap(ops, op, 'i', 32, [16, 8]);
        opMap[b.i64] = buildMemoryOpsMap(ops, op, 'i', 64, [32, 16, 8]);
        opMap[b.f32] = buildMemoryOpsMap(ops, op, 'f', 32);
        opMap[b.f64] = buildMemoryOpsMap(ops, op, 'f', 64);
        map[op] = opMap;
    }
    return map;
}

function buildMemoryOpsMap(ops, op, type, size, subSizes=[]) {
    let func = type + size + '_' + op;
    const map = {};
    if (op === 'load') {
        map[size] = {
            signed: ops[func],
            unsigned: ops[func]
        };
    } else {
        map[size] = ops[func];
    }
    for (let sub of subSizes) {
        if (op === 'load') {
            map[sub] = {
                signed: ops[func + sub + '_s'],
                unsigned: ops[func + sub + '_u']
            };
        } else {
            map[sub] = ops[func + sub];
        }
    }
    return map;
}

/// Base object for the Interpreter API. Modeled after WebAssembly's base object,
/// and imports its Global, Table, and Memory classes directly for use.
/// The Module and Instance classes are custom, and can only be used via
/// async APIs.
const Interpreter = {
    Global,
    Memory,
    Table,
    Module,
    Instance,
    compile,
    compileStreaming,
    instantiate,
    instantiateStreaming,
    isReady: false,
};

Interpreter.ready = b.ready.then(() => {
    Interpreter.isReady = true;
    return Interpreter;
});

module.exports = Interpreter;
