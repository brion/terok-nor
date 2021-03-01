const fs = require('fs');
const path = require('path');
const {Interpreter} = require('../index.js');

const wasm = fs.readFileSync(path.join(__dirname, 'mandelbrot.wasm'));
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

            var x0 = -2.5, x1 = 1, y0 = -1, y1 = 1;
            var cols = 72, rows = 24;
            var maxIters = 1000;

            const start = Date.now();
            for (var row = 0; row < rows; row++) {
                var y = (row / rows) * (y1 - y0) + y0;
                var str = '';
                for (var col = 0; col < cols; col++) {
                    var x = (col / cols) * (x1 - x0) + x0;
                    var iters = await instance.exports.iterate_mandelbrot(x, y, maxIters);
                    if (iters == 0) {
                        str += '.';
                    } else if (iters == 1) {
                        str += '%';
                    } else if (iters == 2) {
                        str += '@';
                    } else if (iters == maxIters) {
                        str += ' ';
                    } else {
                        str += '#';
                    }
                }
                console.log(str);
            }
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


    await test('Optimized async execution', optimized);


    await test('Debuggable async execution', debug);


    let counted = 0;
    let breakpoint = 'fake_location';
    await test('Debuggable async execution with a hit breakpoint', async () => {
        const instance = await debug();

        // hack to find a live breakpoint
        const nodes = Array.from(instance._breakpointIndexes.keys());
        breakpoint = nodes[Math.round((nodes.length - 1) / 2)];

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

    
    const source = path.join(__dirname, 'compiled-mandelbrot.js');
    fs.writeFileSync(
        source,
        (await optimized()).exports.iterate_mandelbrot.toString()
    );
    console.log(`wrote source to ${source}`);

    const sourceDebug = path.join(__dirname, 'compiled-mandelbrot-debug.js');
    fs.writeFileSync(
        sourceDebug,
        (await debug()).exports.iterate_mandelbrot.toString()
    );
    console.log(`wrote source to ${sourceDebug}`);


    console.log('done.');

})();
