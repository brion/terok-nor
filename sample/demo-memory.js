const fs = require('fs');
const path = require('path');
const {Interpreter} = require('../index.js');
const {collect} = require('./utils.js');

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
        const exports = instance.exports;

        async function time(name, cb) {
            const start = Date.now();
            await cb();
            const delta = Date.now() - start;
            console.log(`${name} in ${delta} ms`);
        }
        for (let i = 0; i < repeat; i++) {
            console.log(`${name} (iteration ${i + 1} of ${repeat})`);

            await time('process_i8', exports.process_i8);
            await time('process_i16', exports.process_i16);
            await time('process_i32', exports.process_i32);
            await time('process_i64', exports.process_i64);
            await time('process_f32', exports.process_f32);
            await time('process_f64', instance.exports.process_f64);

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
