// Rechenkern der Schreib-KI. Bauen: python -m ziglang cc -target wasm32-freestanding -O3 -ffast-math -msimd128 -nostdlib
//   -Wl,--no-entry -Wl,--export-memory -Wl,--initial-memory=2097152 -Wl,--max-memory=134217728 -o kern.wasm tools/kern.c
// z += x @ kernel: Kern der LSTM-Schritte (x dünn besetzt möglich), je 4 Zeilen zusammen spart Speicherzugriffe
#ifdef __wasm__
#define EXPORT __attribute__((export_name("matmul")))
#else
#define EXPORT
#endif
EXPORT void matmul(float *restrict z, const float *restrict k, const float *restrict x, int rows, int cols) {
  int i = 0;
  for (; i + 4 <= rows; i += 4) {
    const float a = x[i], b = x[i + 1], c = x[i + 2], d = x[i + 3];
    const float *r0 = k + i * cols, *r1 = r0 + cols, *r2 = r1 + cols, *r3 = r2 + cols;
    for (int j = 0; j < cols; j++) z[j] += a * r0[j] + b * r1[j] + c * r2[j] + d * r3[j];
  }
  for (; i < rows; i++) {
    const float a = x[i];
    const float *r = k + i * cols;
    for (int j = 0; j < cols; j++) z[j] += a * r[j];
  }
}
