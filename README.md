# Handschrift – Notizen mit KI-Handschrift

Notiz-App fürs Tablet (Browser/PWA): Mit dem Stift schreiben und getippten Text **in der eigenen Handschrift** einfügen lassen, ähnlich wie Apples Smart Script auf dem iPad.

## So funktioniert es

- **Meine Handschrift:** Ein paar Sätze (3–5) mit dem Stift auf die Linie schreiben. Gespeichert werden die Stiftbewegungen und nicht nur ein Bild.
- **Text-Werkzeug (T✍):** Auf eine Stelle tippen, Text eingeben, „In Handschrift schreiben“. Ein neuronales Netz (Graves-Handschriftsynthese: LSTM + Attention + Mixture Density Network) bekommt deine Proben als Stil-Vorlage und erzeugt neue Stiftstriche. Jeder Buchstabe fällt dabei jedes Mal etwas anders aus, kopiert wird nichts.
- Die KI läuft **komplett im Browser auf dem Gerät** (Web Worker, eine Zeile pro CPU-Kern). Kein Server, keine Cloud. Notizen und Proben liegen in IndexedDB.
- **Sorgfalt-Regler:** niedrig = lockerer und variabler, hoch = ordentlicher.
- Stift mit Druckstärke, Radierer (auch über die Stifttaste), Rückgängig/Wiederholen, mehrere Notizen, Export als PNG (Teilen-Menü).
- Ist ein Stift erkannt, scrollt der Finger nur und zeichnet nicht (Handballen-Schutz).

## Grenzen

- Das vortrainierte Modell kennt nur englische Zeichen. **Umlaute** werden als a/o/u geschrieben und die Pünktchen ergänzt. **ß** wird als „ss“ geschrieben, **Q/X/Z** als Großbuchstaben gibt es nicht und werden klein geschrieben. Nicht unterstützte Zeichen (z. B. @, €, %) werden ausgelassen.
- Gelegentlich verschreibt sich das Modell (Buchstabe vertauscht oder ausgelassen). Dann rückgängig machen und neu schreiben lassen, oder die Sorgfalt erhöhen.
- Pro Zeile ein paar Sekunden Rechenzeit, je nach Tablet.

## Starten

Statischer Ordner, der über HTTPS ausgeliefert werden muss (für Offline-Modus/Installation), z. B. per GitHub Pages. Lokal zum Testen:

```bash
python -m http.server 8765
```

## Modell

Gewichte aus [sjvasquez/handwriting-synthesis](https://github.com/sjvasquez/handwriting-synthesis), trainiert auf IAM On-Line Handwriting. `tools/export_weights.py` liest den TF-Checkpoint ohne TensorFlow und schreibt `model/weights.bin` (float16, 7 MB). Das Original-Repo hat keine Lizenz: nur für den privaten Gebrauch.
