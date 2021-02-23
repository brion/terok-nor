#include <stdio.h>
#include <emscripten.h>

// z(n+1) = z(n)^2 + c
EMSCRIPTEN_KEEPALIVE
unsigned iterate_mandelbrot(double cx, double cy, unsigned maxIters) {
    double zx = 0.0, zy = 0.0;
    unsigned i = 0;
    for (; i < maxIters && (zx * zx + zy * zy) < 4.0; i++) {
        double new_zx = zx * zx - zy * zy + cx;
        zy = 2 * zx * zy + cy;
        zx = new_zx;
    }
    return i;
}
