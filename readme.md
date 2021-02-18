# Terok Nor: an asynchronous WebAssembly interpreter

Terok Nor is an experimental interpreter for WebAssembly programs to run in browser or node environment asynchronously, allowing execution to be paused and introspected or debugged without blocking the event loop.

The name comes from the original Cardassian name of Star Trek's Deep Space Nine station, which was located near a wormhole inhabited by aliens who experienced a non-linear form of time.

# Author and repo

Hi, I'm Brion Vibber of Wikimedia Foundation! [Primary work repo lives on GitHub for now](https://github.com/brion/terok-nor); please direct bug reports and pull requests there.

# Usage

Terok Nor is in a very early experimental state, and is being shared mostly for my own convenience in development. Beware many things may change!

The API surface is roughly the same as the `WebAssembly` JS API, and in fact `Interpreter.Global` and `Interpreter.Memory` are just aliased to their existing WebAssembly implementations. However all exported functions are `async`, and import functions may be either regular sync or `async` functions (or regular functions returning Promises manually).

Note that this means you can use the same imports for both native `WebAssembly.instantiate` and `Interpreter.insantiate` if they are all synchronous functions -- BUT if your imports call back into any export functions, they must be prepared to deal with that being asynchronous. This means you probably can't take an existing JavaScript runtime that's not designed for use with this and just stick it on the interpreter.

```js
const {Interpreter} = require('terok-nor');

(async () => {

    // Get the binary
    const response = await fetch('module.wasm');
    const fetch = await response.arrayBuffer();

    // Imported functions must be sync for native
    // Can be sync or async for interpreter!
    const imports = {
        env: {
            random: function() {
                return Math.random();
            }
        }
    };

    // Native sync execution
    const native = await WebAssembly.instantiate(wasm, imports);
    native.instance.exports.do_stuff();

    // Interpreted async execution
    const interp = await Interpreter.instantiate(wasm, imports);
    await interp.instance.exports.do_stuff();

})();
```

There is not yet a hook API for debugging or single-stepping, but this is planned, with an optional `async` callback before every opcode evaluation and introspection to VM state.

# Goals and non-goals

Goals:
* run WebAssembly MVP modules correctly
* implement export functions as JavaScript async functions
* support JavaScript async functions as imports
* hook points for callbacks which can pause and introspect execution for debugging or instrumentation
* debugging hooks allowing for disassembly, single-step, stack trace, locals, and memory
* debugging hooks allowing for source-level debugging with DWARF data
* runtime should be relatively lightweight, but not at the expense of functionality

Non-goals:
* not intended to be extremely fast
* not intended to be interoperable with code expecting native WebAssembly modules with sync calls
* not intended to replace native WebAssembly where not available

# Implementation notes

Initial implementation is using binaryen's JS API to load the module and walk through functions etc, as well as to create a runtime ops module which implements the unary, binary, load, and store operations through actual WebAssembly functions.

This is a great way to get started, but has several downsides:
* the dependency is large and includes optimizing compiler stages we don't need
* there's no byte-position information about each instruction, so you can't hook it up to source-level debugging that depends on mapping the WebAssembly binary to a source location

If it's worth pursuing this project, a custom JS-based WebAssembly parser would probably be a good investment. The ops module can be built as a dev dependency, so we just need to walk through the module and produce a suitable AST with exactly the information needed for execution and debugging in a format that's efficient to do it with.

With the current in-execution walk of the expression-tree AST, the native JavaScript async stack is used to implement branches and loops. Branches that unwind to another block are implemented as exceptions, which might turn out to be a performance bottleneck. This could be changed to explicit unwinding-state passing if that turns out to be cheaper than the exception handling.

Single-stepping will require adding a per-opcode async callback point, which could call a user-level callback which delays further execution based on a debugger's pause state.

Clean APIs for debugging introspection have not yet been devised. All APIs are to be considered unstable.

# Alternatives considered

A more state-machine-esque interpreter design that had a single-step call was considered, but has a number of difficulties:
* it's a pain to implement block stacks that the JS compiler can already do for me in async functions
* since call opcodes can be to imported async functions, you'd have to model step as an async function or Promise anyway

# Potential optimizations

Speed optimizations for non-single-step running could involve packing more rows of non-call instructions together in runs which can be individually compiled as Wasm subfunctions. But this might be a lot of trouble and not worth it.

# License

Copyright (c) 2021 Brion Vibber

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
