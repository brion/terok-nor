const fs = require('fs');
const path = require('path');
const {Interpreter} = require('../index.js');

const wasm = fs.readFileSync(path.join(__dirname, 'memory.wasm'));
const imports = {
    env: {
        //
    }
};

(async () => {

    // Give some warmup time for the JS compiler!
    const repeat = 3;

    async function test(name, setup, after=null) {
        const instance = await setup();

        for (let i = 0; i < repeat; i++) {
            console.log(`${name} (iteration ${i + 1} of ${repeat})`);

            const start = Date.now();
            //await instance.exports.process_all();

            await instance.exports.process_i8();
            await instance.exports.process_i16();
            await instance.exports.process_i32();
            //await instance.exports.process_i64(); // bignum integration is not deployed yet on v8
            await instance.exports.process_f32();
            await instance.exports.process_f64();

            const delta = Date.now() - start;

            console.log(delta + ' ms');
            console.log('');
        }
        if (after) {
            await after(instance);
        }
    }

    async function native() {
        const {instance} = await WebAssembly.instantiate(wasm, imports);
        return instance;
    }

    async function optimized() {
        const {instance} = await Interpreter.instantiate(wasm, imports);
        return instance;
    }

    async function debug() {
        const {instance} = await Interpreter.instantiate(wasm, imports, {
            debug: true
        });
        return instance;
    }

    await test('Native sync execution', native);

    
    function collect(instance) {
        const sources = [];
        for (let [name, func] of Object.entries(instance.exports)) {
            sources.push(`const ${name} = ${func.toString()};`);
        }
        return sources.join('\n\n');
    }

    const source = path.join(__dirname, 'compiled-memory.js');
    fs.writeFileSync(source, collect(await optimized()));
    console.log(`wrote source to ${source}`);

    const sourceDebug = path.join(__dirname, 'compiled-memory-debug.js');
    fs.writeFileSync(sourceDebug, collect(await debug()));
    console.log(`wrote source to ${sourceDebug}`);


    await test('Optimized async execution', optimized);


    await test('Debuggable async execution', debug);


    let counted = 0;
    let breakpoint = 'fake_location';
    await test('Debuggable async execution with a hit breakpoint', async () => {
        const instance = await debug();

        // hack to find a live breakpoint
        const nodes = Array.from(instance._breakpointIndexes.keys());
        breakpoint = nodes[Math.round((nodes.length - 1) * 3 / 4)];

        instance.debugger = async () => {
            counted++;
        };
        instance.setBreakpoint(breakpoint);
        return instance;
    }, async (instance) => {
        instance.clearBreakpoint(breakpoint);
        console.log(`Hit breakpoint ${counted} times on ${breakpoint}!`);
    });

    
    counted = 0;
    await test('Debuggable async execution with a single-step hook', async () => {
        const instance = await debug();
        instance.debugger = async () => {
            counted++;
        };
        instance.singleStep = true;
        return instance;
    }, async (instance) => {
        instance.singleStep = false;
        console.log(`Hit callback ${counted} times!`);
    });

    console.log('done.');

})();
