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

Each function is compiled via JavaScript source into an async function which maintains VM state for the frame (locals, stack, and a pointer to the AST node). JavaScript control structures are used to implement blocks, branches and loops; most other opcodes call into a stub WebAssembly module per opcode, while a few are implemented directly in JavaScript where the semantics are clear. The stack is kept virtually in local variables, as are the Wasm locals; when a debug callback is attached they are spilled into arrays for introspection.

Single-stepping is possible by specifying a callback as an async function, and simply not returning until you're done. Each input opcode invokes the callback if it's provided, with the current execution frame and a pointer to the AST node. Set the function on `instance.callback`, and set back to null to disable.

Clean APIs for debugging introspection have not yet been devised. All APIs are to be considered unstable.

# Limitations

No shared memory or SIMD or other non-MVP features are supported yet.

Floating point types may not preserve NaN bit patterns due to JavaScript's canonicalizations, so code using NaN-boxing or other fancy techniques will have trouble.

Eval permissions are required to create new code with the Function constructor. If it's required to deploy in an environment with eval disabled, something would have to be rigged up to provide the JS source separately (server-side compilation) and fill it with the appropriate closure state at runtime.

# Debugger plans

Need to think about general plans for supporting source-level and assembly-level debugging, which is desirable when connecting to native server-side processes as well.

In the meantime, a narrower AST format for the parsed code would be helpful in setting up a proto-debugger that's not dependent on binaryen internal APIs.

# Alternatives considered

A more state-machine-esque interpreter design that had a single-step call was considered, but has a number of difficulties:
* it's a pain to implement block stacks that the JS compiler can already do for me in async functions
* since call opcodes can be to imported async functions, you'd have to model step as an async function or Promise anyway
* it's so slow when not actively debugging

# License

Copyright (c) 2021 Brion Vibber

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
