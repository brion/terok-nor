#include <emscripten.h>

extern
EM_IMPORT(my_putc)
int my_putc(int fd, int ch);

int my_puts(const char *str)
{
    while (*str) {
        my_putc(0, *str);
        str++;
    }
    my_putc(0, '\n');
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void hello() {
    my_puts("Hello, world");
}
