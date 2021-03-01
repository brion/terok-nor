# Terok Nor: an asynchronous WebAssembly interpreter

Terok Nor is an experimental interpreter for WebAssembly programs to run in browser or node environment asynchronously, allowing execution to be paused and introspected or debugged without blocking the event loop.

The name comes from the original Cardassian name of Star Trek's Deep Space Nine station, which was located near a wormhole inhabited by aliens who experienced a non-linear form of time.

# Author and repo

Hi, I'm Brion Vibber of Wikimedia Foundation! [Primary work repo lives on GitHub for now](https://github.com/brion/terok-nor); please direct bug reports and pull requests there.

# Usage

Terok Nor is in a very early experimental state, and is being shared mostly for my own convenience in development. Beware many things may change!

The API surface is roughly the same as the `WebAssembly` JS API, and in fact `Interpreter.Global` and `Interpreter.Memory` are just aliased to their existing WebAssembly implementations. However all exported functions are `async`, and import functions may be either regular sync or `async` functions (or regular functions returning Promises manually).

Note that this means you can use the same imports for both native `WebAssembly.instantiate` and `Interpreter.insantiate` if they are all synchronous functions -- BUT if your imports call back into any export functions, they must be prepared to deal with that being asynchronous. This means you probably can't take an existing JavaScript runtime that's not designed for use with this and just stick it on the interpreter.

Note that the API surface may change a bit to accomodate pre-compiling Module objects into source code that can be loaded up from separate server-side compilation.

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

    // Recompiled async execution
    const {instance} = await Interpreter.instantiate(wasm, imports);
    await instance.exports.do_stuff();

    // Again, but with a debug hook
    instance.singleStep = true;
    let first = true;
    instance.debugger = async function() {
        // You can arbitrarily pause or delay execution.
        // This slows execution and dumps stack frames on
        // every breakpoint hit.
        if (!first) {
            first = false;
            await new Promise((resolve, reject) => {
                setTimeout(resolve, 250);
            });
        }
        const [frame] = instance.stackTrace(-1);
        console.log(frame.sourceLocation);
    };
    await instance.exports.do_stuff();

    // Or set some breakpoints
    // @fixme breakpoints are incomplete right now
    //
    // they work well but the location IDs are the in-memory
    // references of the AST nodes in the parser.
    // This will be changed to support sensible source locations,
    // and to provide disassembly for modules with no debug info.
    instance.singleStep = false;
    instance.setBreakpoint('foobar.c:234');
    await instance.exports.do_stuff();


    // You could use this to implement a debugger UI
    class DebugAbort extends Error {
        constructor() {
            super("Debug abort");
        }
    }
    const breakpoints = new Set();
    const continueButton = document.querySelector('#debug-continue');
    const abortButton = document.querySelector('#debug-abort');
    function abortHandler() {
        continueButton.disabled = true;
        continueButton.click = null;
        abortButton.disabled = true;
        abortButton.click = null;
        instance.debugger = async () => {
            throw new DebugAbort();
        };
    }
    abortButton.click = abortHandler;
    continueButton.disabled = true;
    instance.debugger = async () => {
        await new Promise((resolve, reject) => {
            continueButton.click = () => {
                continueButton.disabled = true;
                continueButton.click = null;
                resolve();
            };
            continueButton.disabled = false;

            abortButton.click = () => {
                abortHandler();
                reject(new DebugAbort());
            };

            // Stack and locals can be dumped for your introspection pleasure.
            // This causes some slowdown, as the array is constructed on demand
            // from closure state when you call `stackTrace()`.
            //
            // If you only need the top frame, ask for it using `slice`-style args:
            let [frame] = instance.stackTrace(-1);
            console.log('stack', frame.stack);
            console.log('locals', frame.locals);
            console.log('source location', frame.sourceLocation);
        });
    };
    await instance.exports.do_stuff();
})();
```

# Goals and non-goals

Goals:
* run WebAssembly MVP modules correctly
* implement export functions as JavaScript async functions
* support JavaScript async functions as imports
* hook points for callbacks which can pause and introspect execution for debugging or instrumentation
* debugging hooks allowing for disassembly, single-step, stack trace, locals, and memory
* debugging hooks allowing for source-level debugging with DWARF data
* runtime should be relatively lightweight, but not at the expense of functionality
* reasonably fast given the constraints

Non-goals:
* not intended to be extremely fast
* not intended to be interoperable with code expecting native WebAssembly modules with sync calls
* not intended to replace native WebAssembly where not available

# Implementation notes

Initial implementation is using binaryen's JS API to load the module and walk through functions etc, compiling into JavaScript async function source code which is then instantiated. The compiler and runtime are currently a bit intertwined, but these will be separated to allow precompiling `Module` subclass implementations that can be instantiated with a minimal runtime.

This is a great way to get started, but has several downsides:
* the dependency is large and includes optimizing compiler stages we don't need
* there's no byte-position information about each instruction, so you can't hook it up to source-level debugging that depends on mapping the WebAssembly binary to a source location

If it's worth pursuing this project with client-side compilation, a custom JS-based WebAssembly parser would probably be a good investment. This would have to validate the module's structure and stack behavior to ensure safe compilation.

Each function is compiled via JavaScript source into an async function which maintains VM state for the frame: locals, stack, and (for debug mode) the source locations of each node). JavaScript control structures are used to implement blocks, branches and loops; opcodes are implemented directly as JS operations when possible, or by annoying polyfills when necessary. The stack is kept virtually in local variables, as are the Wasm locals; when a debug callback is attached they are spilled into arrays for introspection.

Single-stepping is possible by setting `instance.singleStep = true` and specifying an async callback on `instance.debugger`. When you're ready to proceed, return from the callback. To be called only on specific breakpoints, use `instance.setBreakpoint(location)`. Currently the source location IDs are the in-Wasm-memory pointers of the expression nodes in binaryen.js which is .... not good. ;)

These will be made more usable later, hopefully with support for automatic disassembly generation and source refs via DWARF debugging info.

You can get a stack trace of stack `Frame` objects by calling `instance.stackTrace()`; it accepts start and end parameters in the style of `Array.prototype.slice` so you can optionally ask for a subset of the stack.

Currently these APIs are incomplete and not stable.

# Limitations

No shared memory or SIMD or other non-MVP features are supported yet.

Floating point types may not preserve NaN bit patterns due to JavaScript's canonicalizations, so code using NaN-boxing or other fancy techniques could have trouble.

Eval permissions are required to create new code with the Function constructor. If it's required to deploy in an environment with eval disabled, something would have to be rigged up to provide the JS source separately (server-side compilation) and fill it with the appropriate closure state at runtime.

Nothing is hardened against re-entrancy; if you call into a second function while another one is running and in progress it might work, or it might cause problems.

`i64` operations are very slow, going through `BigInt` which means heap allocation for every temporary value.

# Debugger plans

Need to think about general plans for supporting source-level and assembly-level debugging, which is desirable when connecting to native server-side processes as well.

In the meantime, a narrower AST format for the parsed code would be helpful in setting up a proto-debugger that's not dependent on binaryen internal APIs.

# Alternatives considered

A more state-machine-esque interpreter design that had a single-step call was considered, but has a number of difficulties:
* it's a pain to implement block stacks that the JS compiler can already do for me in async functions
* since call opcodes can be to imported async functions, you'd have to model step as an async function or Promise anyway
* it's so slow when not actively debugging

A chain of async function closures implemented around each opcode was also tried; this worked well but had too much function call overhead in the hot path when not debugging. Moving to JS compilation and moving stack and locals inside the function improved runtime performance by about 20x on the Mandelbrot iterator demo.

# License

Copyright (c) 2021 Brion Vibber

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
