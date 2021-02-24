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
        this.callback = null;

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


/// Execution state frame for a single function
///
/// Will run asynchronously, but is *not* safe for re-entrant calls
/// during a single execution run.
///
/// Not meant to be exposed externally.
class Frame {
    constructor(instance) {
        this.instance = instance;
        this.locals = null;
        this.stack = null;
    }
}

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

    static compileBase(instance, expr, params, results, vars) {
        const compiler = new Compiler(instance, params, vars);
        const inst = compiler.enclose(instance);
        const frame = compiler.enclose(Frame);
        const paramNames = params.map((_type, index) => `param${index}`);
        const setArgs = paramNames.map((name, index) => {
            return `local${index} = ${coerceValue(params[index], name)};`;
        });
        const body = compiler.compile(expr);
        const hasResult = (results !== b.none);
        const func = `
            return async (${paramNames.join(', ')}) => {
                const instance = ${inst};
                const table = instance.table;
                const frame = new ${frame}(instance);
                ${
                    compiler.maxDepth
                    ? `let ${compiler.stackVars(compiler.maxDepth).join(`, `)};`
                    : ``
                }
                ${
                    compiler.localDefaults.length
                    ? `let ${compiler.localInits().join(`, `)};`
                    : ``
                }
                function spillLocals() {
                    return [${compiler.localVars().join(`, `)}];
                }
                ${setArgs.join('\n')}
                ${body}
                ${hasResult ? `return ${compiler.pop()};` : ``}
            };
        `;
        const closureNames = compiler.closure.map((_val, index) => `closure${index}`);
        const args = closureNames.concat([func]);
        console.log({closureNames, closure: compiler.closure})
        console.log(func);
        return Reflect.construct(Function, args).apply(null, compiler.closure);
    }

    static compileFunction(instance, func) {
        return Compiler.compileBase(instance, func.body, b.expandType(func.params), func.results, func.vars)
    }

    static compileExpression(instance, expr) {
        return Compiler.compileBase(instance, expr, [], expr.type, []);
    }

    /// Compile a single expression from the AST into some JS async function source
    compile(expression) {
        const expr = b.getExpressionInfo(expression);
        const handler = expressionMap(expr.id);
        if (this[handler]) {
            return this[handler](expr);
        } else {
            throw new RangeError("Cannot compile unknown expression");
        }
    }

    compileMultiple(expressions) {
        return expressions.map((expression) => this.compile(expression)).join('\n');
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
                return JSON.stringify(value);
            case 'bigint':
                return `${value}n`;
            default:
                return this.enclose(value);
        }
    }

    label(name) {
        let index = this.labels.indexOf(name);
        if (index === -1) {
            index = this.labels.push(name) - 1;
        }
        return 'label' + index;
    }

    callback(expr) {
        const node = this.enclose(expr);
        return `if (instance.callback) {
            frame.stack = [${this.stackVars(this.stack.length).join(`, `)}];
            frame.locals = spillLocals();
            await instance.callback(frame, ${node});
        }`;
    }

    vars(base, max) {
        const vars = new Array(max);
        for (let i = 0; i < max; i++) {
            vars[i] = `${base}${i}`;
        }
        return vars;
    }

    stackVars(max) {
        return this.vars(`stack`, max);
    }

    localVars() {
        return this.vars(`local`, this.localDefaults.length);
    }

    localInits() {
        return this.localDefaults.map((value, index) => `local${index} = ${this.literal(value)}`);
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

    drop() {
        this.stack.pop();
        return ``;
    }

    peek() {
        const depth = this.stack.length;
        return `stack${depth - 1}`;
    }

    popArgs(num) {
        const items = new Array(num);
        for (let i = num - 1; i >= 0; i--) {
            items[i] = this.pop();
        }
        return items.join(', ');
    }

    saveStack() {
        return this.stack.length;
    }

    restoreStack(saved, preserve=0) {
        const depth = this.stack.length;
        this.stack.splice(saved, (depth - saved) - preserve);

        const copies = [];
        for (let i = 0; i < preserve; i++) {
            copies.push(`stack${saved + i} = stack${(depth - preserve) + i}`);
        }
        return copies.join('\n');
    }

    _compileBlock(expr) {
        let saved;
        if (expr.name !== '') {
            let label;
            return `
                ${this.callback(expr)}
                {
                    ${saved = this.saveStack()}
                    ${label = this.label(expr.name)}:
                    for (;;) {
                        ${this.compileMultiple(expr.children)}
                        break ${label};
                    }
                    ${this.restoreStack(saved, resultCount(expr.type))}
                }
            `;
        }
        return this.compileMultiple(expr.children);
    }

    _compileIf(expr) {
        if (expr.ifFalse) {
            return `
                ${this.compile(expr.condition)}
                ${this.callback(expr)}
                if (${this.pop()}) {
                    ${this.compile(expr.ifTrue)}
                } else {
                    ${this.compile(expr.ifFalse)}
                }
            `;
        }
        return `
            ${this.compile(expr.condition)}
            ${this.callback(expr)}
            if (${this.pop()}) {
                ${this.compile(expr.ifTrue)}
            }
        `;
    }

    _compileLoop(expr) {
        let outer, inner, saved;
        return `
            ${this.callback(expr)}
            {
                ${saved = this.saveStack()}
                ${outer = this.label(expr.name + '$$loop')}:
                for (;;) {
                    ${inner = this.label(expr.name)}:
                    for (;;) {
                        ${this.compile(expr.body)}
                        break ${outer};
                    }
                }
                ${this.restoreStack(saved, resultCount(expr.type))}
            }
        `;
    }

    _compileBreak(expr) {
        if (expr.condition) {
            return `
                ${this.compile(expr.condition)}
                ${this.callback(expr)}
                if (${this.pop()}) {
                    break ${this.label(expr.name)};
                }
            `;
        }
        return `
            ${this.callback(expr)}
            break ${this.label(expr.name)};
        `;
    }

    _compileSwitch(expr) {
        const labels = expr.names.map((name) => this.label(name));
        return `
            ${this.compile(expr.condition)}
            ${this.callback(expr)}
            switch (${this.pop()}) {
                ${labels.map((label, index) => `
                    case ${index}:
                        break ${label};
                `).join('\n')}
                default:
                    break ${this.label(expr.defaultName)};
            }
        `;
    }

    _compileCall(expr) {
        const func = this.enclose(this.instance._funcs[expr.target]);
        const hasResult = (expr.type !== b.none);
        let args, result;
        return `
            ${this.compileMultiple(expr.operands)}
            ${this.callback(expr)}
            ${
                args = this.popArgs(expr.operands.length),
                result = `await ${func}(${args})`,
                hasResult ? this.push(result) : result
            }
        `;
    }

    _compileCallIndirect(expr) {
        const hasResult = (expr.type !== b.none);
        let args, index, result;
        return `
            ${this.compile(expr.target)}
            ${this.compileMultiple(expr.operands)}
            ${this.callback(expr)}
            ${
                args = this.popArgs(expr.operands.length),
                index = this.pop(),
                // @todo enforce signature matches
                result = `await (table.get(${index}))(${args})`,
                hasResult ? this.push(result) : result
            }
        `;
    }

    _compileLocalGet(expr) {
        return `
            ${this.callback(expr)}
            ${this.push(`local${expr.index}`)}
        `;
    }

    _compileLocalSet(expr) {
        if (expr.isTee) {
            return `
                ${this.compile(expr.value)}
                ${this.callback(expr)}
                local${expr.index} = ${this.peek()};
            `;
        } else {
            return `
                ${this.compile(expr.value)}
                ${this.callback(expr)}
                local${expr.index} = ${this.pop()};
            `;
        }
    }

    _compileGlobalGet(expr) {
        const global = this.enclose(this.instance._globals[expr.name]);
        return `
            ${this.callback(expr)}
            ${this.push(`${global}.value`)}
        `;
    }

    _compileGlobalSet(expr) {
        const global = this.enclose(this.instance._globals[expr.name]);
        return `
            ${this.compile(expr.value)}
            ${this.callback(expr)}
            ${global}.value = ${this.pop()};
        `;
    }

    _compileLoad(expr) {
        const func = this.enclose(this.instance._ops.memory.load[expr.type][expr.bytes << 3][expr.isSigned ? 'signed' : 'unsigned']);
        return `
            ${this.compile(expr.ptr)}
            ${this.callback(expr)}
            ${this.push(`${func}(${this.pop()} + ${expr.offset})`)}
        `;
    }

    _compileStore(expr) {
        const valueInfo = b.getExpressionInfo(expr.value);
        const func = this.enclose(this.instance._ops.memory.store[valueInfo.type][expr.bytes << 3]);
        let value, ptr;
        return `
            ${this.compile(expr.ptr)}
            ${this.compile(expr.value)}
            ${this.callback(expr)}
            ${
                value = this.pop(),
                ptr = this.pop(),
                `${func}(${ptr} + ${expr.offset}, ${value})`
            }
        `;
    }

    _compileConst(expr) {
        let value;
        if (expr.type == b.i64) {
            const {high, low} = expr.value;
            value = (BigInt(high | 0) << 32n) | BigInt(low >>> 0);
        } else {
            value = expr.value;
        }
        return `
            ${this.callback(expr)}
            ${this.push(this.literal(value))}
        `;
    }
    
    unaryOp(op, operand) {
        switch (op) {
        case b.NegFloat32:
        case b.NegFloat64:
            return `-${operand}`;
        default:
            const func = this.enclose(this.instance._ops.binary[op]);
            return `${func}(${operand})`;
        }
    }

    _compileUnary(expr) {
        return `
            ${this.compile(expr.value)}
            ${this.callback(expr)}
            ${this.push(this.unaryOp(expr.op, this.pop()))}
        `;
    }

    binaryOp(op, left, right) {
        switch (op) {
            case b.AddInt32:
                return `${left} + ${right} | 0`;
            case b.AddFloat64:
                return `${left} + ${right}`;
            case b.SubInt32:
                return `${left} - ${right} | 0`;
            case b.SubFloat64:
                return `${left} - ${right}`;
            case b.MulInt32:
                return `Math.imul(${left}, ${right})`;
            case b.MulFloat64:
                return `${left} * ${right}`;
            case b.DivFloat64:
                return `${left} / ${right}`;
            case b.AndInt32:
                return `${left} & ${right}`;
            case b.OrInt32:
                return `${left} | ${right}`;
            case b.XorInt32:
                return `${left} ^ ${right}`;
            case b.ShlInt32:
                return `${left} << ${right}`;
            case b.ShrSInt32:
                return `${left} >> ${right}`;
            case b.ShrUInt32:
                return `(${left} >>> ${right}) | 0`;
            case b.EqInt32:
                return `${left} === ${right}`;
            case b.LtSInt32:
                return `${left} < ${right}`;
            case b.LtUInt32:
                return `(${left} >>> 0) < (${right} >>> 0)`;
            case b.LtFloat32:
            case b.LtFloat64:
                return `${left} < ${right}`;
            case b.LeSInt32:
                return `${left} <= ${right}`;
            case b.LeUInt32:
                return `(${left} >>> 0) <= (${right} >>> 0)`;
            case b.LeFloat32:
            case b.LeFloat64:
                return `${left} <= ${right}`;
            case b.GtSInt32:
                return `${left} > ${right}`;
            case b.GtUInt32:
                return `(${left} >>> 0) > (${right} >>> 0)`;
            case b.GtFloat32:
            case b.GtFloat64:
                return `${left} > ${right}`;
            case b.GeSInt32:
                return `${left} >= ${right}`;
            case b.GeUInt32:
                return `(${left} >>> 0) >= (${right} >>> 0)`;
            case b.GeFloat32:
            case b.GeFloat64:
                return `${left} >= ${right}`;
            default:
                const func = this.enclose(this.instance._ops.binary[op]);
                return `${func}(${left}, ${right})`;
        }
    }

    _compileBinary(expr) {
        let left, right;
        return `
            ${this.compile(expr.left)}
            ${this.compile(expr.right)}
            ${this.callback(expr)}
            ${
                right = this.pop(), 
                left = this.pop(),
                this.push(this.binaryOp(expr.op, left, right))
            }
        `;
    }

    _compileSelect(expr) {
        let ifTrue, ifFalse, cond;
        return `
            ${this.compile(expr.ifTrue)}
            ${this.compile(expr.ifFalse)}
            ${this.compile(expr.condition)}
            ${this.callback(expr)}
            ${
                cond = this.pop(),
                ifFalse = this.pop(),
                ifTrue = this.pop(),
                this.push(`${cond} ? ${ifTrue} : ${ifFalse}`)
            }
        `;
    }

    _compileDrop(expr) {
        return `
            ${this.compile(expr.value)}
            ${this.callback(expr)}
            ${this.drop()};
        `;
    }

    _compileMemorySize(expr) {
        const memory = this.enclose(this.instance._memory);
        return `
            ${this.callback(expr)}
            ${this.push(`${memory}.buffer.length / 65536`)}
        `;
    }

    _compileMemoryGrow(expr) {
        const memory = this.enclose(this.instance._memory);
        return `
            ${this.compile(expr.delta)}
            ${this.callback(expr)}
            ${this.push(`${memory}.grow(${this.pop()})`)}
        `;
    }

    _compileReturn(expr) {
        if (expr.value) {
            return `
                ${this.compile(expr.value)}
                ${this.callback(expr)}
                return ${this.pop()};
            `;
        } else {
            return `
                ${this.callback(expr)}
                return;
            `;
        }
    }

    _compileNop(expr) {
        return `${this.callback(expr)}`;
    }

    _compileUnreachable(expr) {
        return `
            ${this.callback(expr)}
            throw new WebAssembly.RuntimeError("Unreachable");
        `;
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
        const ops = new Array(maxOp(unaryOps));
        for (let [op] of list) {
            ops[op] = instance.exports[prefix + op];
        }
        return ops;
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
