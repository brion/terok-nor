const fs = require('fs');
const path = require('path');
const {Interpreter} = require('../index.js');

const wasm = fs.readFileSync(path.join(__dirname, 'light.wasm'));
const imports = {
    env: {
        //
    }
};

(async () => {

    async function test(instance) {
        // Note that calling everything with await is safe
        // for sync code too.
        const ie = instance.exports;

        console.log('on?', await ie.is_lit());

        console.log('turning on:');
        await ie.turn_on();

        console.log('on?', await ie.is_lit());

        console.log('turning off:');
        await ie.turn_off();

        console.log('on?', await ie.is_lit());

        // now try something clever
        console.log('stackSave:', await ie.stackSave());
    }

    console.log('Native sync execution:');
    const native = await WebAssembly.instantiate(wasm, imports);
    await test(native.instance);

    console.log('Interpreted async execution:');
    const interp = await Interpreter.instantiate(wasm, imports);
    await test(interp.instance);

    console.log('done.');

})();
