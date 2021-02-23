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

    async function test(instance) {
        var x0 = -2.5, x1 = 1, y0 = -1, y1 = 1;
        var cols = 72, rows = 24;
        var maxIters = 1000;

        for (var row = 0; row < rows; row++) {
            var y = (row / rows) * (y1 - y0) + y0;
            var str = '';
            for (var col = 0; col < cols; col++) {
                var x = (col / cols) * (x1 - x0) + x0;
                var iters = await instance.exports.iterate_mandelbrot(x, y, maxIters);
                //console.log(iters);
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
    }

    console.log('Native sync execution:');
    const native = await WebAssembly.instantiate(wasm, imports);
    await test(native.instance);

    console.log('Interpreted async execution:');
    const interp = await Interpreter.instantiate(wasm, imports);
    await test(interp.instance);

    console.log('done.');

})();
