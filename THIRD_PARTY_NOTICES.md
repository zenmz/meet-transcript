# Third-party notices

Meet Transcript sendiri berlisensi MIT (lihat [LICENSE](LICENSE)). Ekstensi ini
**ikut mendistribusikan** komponen pihak ketiga di bawah ini, di dalam repo
maupun di dalam ZIP rilis. Lisensi masing-masing tetap berlaku untuk file-file
tersebut.

---

## Transformers.js — `lib/vendor/transformers.min.js`

- Pemilik hak cipta: The HuggingFace Inc. team
- Lisensi: **Apache License 2.0**
- Sumber: https://github.com/huggingface/transformers.js
- Teks lisensi lengkap: [`lib/vendor/LICENSE.transformers.txt`](lib/vendor/LICENSE.transformers.txt)

Didistribusikan tanpa modifikasi (bundle rilis apa adanya).

---

## ONNX Runtime Web — `lib/vendor/ort-wasm-simd-threaded.jsep.wasm`

- Pemilik hak cipta: Microsoft Corporation
- Lisensi: **MIT**
- Sumber: https://github.com/microsoft/onnxruntime

Binary WASM ini adalah bagian dari paket `onnxruntime-web` yang dipakai
Transformers.js sebagai runtime inferensi. Didistribusikan tanpa modifikasi.

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Bobot model Whisper (TIDAK ikut didistribusikan)

Mode **Whisper di browser** mengunduh bobot model `Xenova/whisper-*` dari
huggingface.co saat dipakai, lalu menyimpannya di cache peramban. Bobot itu
tidak ada di repo ini maupun di ZIP rilis, dan tunduk pada lisensi
masing-masing repositori model di Hugging Face.
