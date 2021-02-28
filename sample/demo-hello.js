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

    async function test(instance) {
        return await instance.exports.hello();
    }

    console.log('Native sync execution:');
    const native = await WebAssembly.instantiate(wasm, imports);
    await test(native.instance);

    console.log('Interpreted async execution:');
    const interp = await Interpreter.instantiate(wasm, imports);
    await test(interp.instance);

    console.log('Debuggable async execution:');
    const debug = await Interpreter.instantiate(wasm, imports, {
        debug: true
    });
    await test(debug.instance);

    console.log('Debuggable async execution with a hook:');
    debug.instance.callback = async (frame) => {};
    await test(debug.instance);

    console.log('done.');

})();
