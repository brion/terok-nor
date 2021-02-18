#include <emscripten.h>

int lit = 0;

EMSCRIPTEN_KEEPALIVE
void turn_on(void) {
    lit = 1;
}

EMSCRIPTEN_KEEPALIVE
void turn_off(void) {
    lit = 0;
}

EMSCRIPTEN_KEEPALIVE
int is_lit(void) {
    return lit;
}
