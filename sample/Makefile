.FAKE : all clean

all : hello.wasm light.wasm

clean :
	rm -f hello.wasm
	rm -f light.wasm

hello.wasm : hello.c
	emcc -o hello.wasm -O2 --no-entry -s LLD_REPORT_UNDEFINED -s ERROR_ON_UNDEFINED_SYMBOLS=0 hello.c

light.wasm : light.c
	emcc -o light.wasm -O2 --no-entry light.c
