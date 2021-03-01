#include <emscripten.h>

#define ITEMS (1024 * 1024)

static char buffer_i8[ITEMS];
static short buffer_i16[ITEMS];
static int buffer_i32[ITEMS];
static long long buffer_i64[ITEMS];
static float buffer_f32[ITEMS];
static double buffer_f64[ITEMS];

EMSCRIPTEN_KEEPALIVE
__attribute__((noinline))
void process_i8(void) {
    for (int i = 0; i < ITEMS; i++) {
        buffer_i8[i] += i;
    }
}

EMSCRIPTEN_KEEPALIVE
__attribute__((noinline))
void process_i16(void) {
    for (int i = 0; i < ITEMS; i++) {
        buffer_i16[i] += i;
    }
}

EMSCRIPTEN_KEEPALIVE
__attribute__((noinline))
void process_i32(void) {
    for (int i = 0; i < ITEMS; i++) {
        buffer_i32[i] += i;
    }
}

EMSCRIPTEN_KEEPALIVE
__attribute__((noinline))
void process_i64(void) {
    for (int i = 0; i < ITEMS; i++) {
        buffer_i64[i] += i;
    }
}

EMSCRIPTEN_KEEPALIVE
__attribute__((noinline))
void process_f32(void) {
    for (int i = 0; i < ITEMS; i++) {
        buffer_f32[i] += i;
    }
}

EMSCRIPTEN_KEEPALIVE
__attribute__((noinline))
void process_f64(void) {
    for (int i = 0; i < ITEMS; i++) {
        buffer_f64[i] += i;
    }
}

EMSCRIPTEN_KEEPALIVE
void process_all(void) {
    process_i8();
    process_i16();
    process_i32();
    process_i64();
    process_f32();
    process_f64();
}
