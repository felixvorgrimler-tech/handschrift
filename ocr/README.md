# Texterkennung für „Gründlich prüfen“

`de-trocr/` ist [EpsilonGreedy/TrOCR_small_german_handwritten](https://huggingface.co/EpsilonGreedy/TrOCR_small_german_handwritten)
(Lizenz AFL-3.0), mit optimum nach ONNX exportiert und auf 8 Bit quantisiert, damit es mit transformers.js im Browser läuft.
Die App lässt jede erzeugte Stück-Variante davon lesen und nimmt die, die am besten zum Text passt.
