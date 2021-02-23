const fs = require('fs');
const path = require('path');
const {Interpreter} = require('../index.js');

const wasm = fs.readFileSync(path.join(__dirname, 'hello.wasm'));
const imports = {
    env: {
        my_putc: function(_fd, c) {
            console.log(String.fromCharCode(c));
            return c;
        }
    }
};

(async () => {

    console.log('Native sync execution:');
    const native = await WebAssembly.instantiate(wasm, imports);
    native.instance.exports.hello();

    console.log('Interpreted async execution:');
    const interp = await Interpreter.instantiate(wasm, imports);
    await interp.instance.exports.hello();

    console.log('done.');

})();
