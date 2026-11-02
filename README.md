# Handschrift – Notizen mit KI-Handschrift

Notiz-App fürs Tablet (Browser/PWA): Mit dem Stift schreiben und getippten Text **in der eigenen Handschrift** einfügen lassen, ähnlich wie Apples Smart Script auf dem iPad.

## So funktioniert es

- **Meine Handschrift:** Ein paar Sätze (3–5) mit dem Stift auf die Linie schreiben. Gespeichert werden die Stiftbewegungen und nicht nur ein Bild.
- **Text-Werkzeug (T✍):** Auf eine Stelle tippen, Text eingeben, „In Handschrift schreiben“. Ein neuronales Netz (Graves-Handschriftsynthese: LSTM + Attention + Mixture Density Network) bekommt deine Proben als Stil-Vorlage und erzeugt neue Stiftstriche. Jeder Buchstabe fällt dabei jedes Mal etwas anders aus, kopiert wird nichts.
- Die KI läuft **komplett im Browser auf dem Gerät** (Web Worker, eine Zeile pro CPU-Kern). Kein Server, keine Cloud. Notizen und Proben liegen in IndexedDB.
- **Sorgfalt-Regler:** niedrig = lockerer und variabler, hoch = ordentlicher.
- Stift mit Druckstärke, Radierer (auch über die Stifttaste), Rückgängig/Wiederholen, mehrere Notizen, Export als PNG oder **für Notewise** (Teilen-Menü).
- **Export für Notewise (.notewise):** In Notewise importiert (auch in eine bestehende Notiz) wird die Schrift zu echten
  Notewise-Strichen auf Notewise-Papier: radieren, verschieben, umfärben wie eigene Schrift. Das Format (ZIP mit
  Base64-Protobuf je Notiz/Seite) ist aus einer Notewise-Exportdatei entschlüsselt, siehe `notewise.js`. A4-Seite
  3508 × 4960 Einheiten, App-Seite 1000 breit, also Faktor 3,5.
- **Seiten im A4-Format** wie in Notewise (1000 × 1414 Einheiten): Seitenwechsel sind in der Notiz zu sehen, eingefügter
  Text springt am Seitenende auf die erste Linie der nächsten Seite, und jede Seite wird beim Export eine Notewise-Seite.
- Ist ein Stift erkannt, scrollt der Finger nur und zeichnet nicht (Handballen-Schutz).

## Eigene Handschrift aus Notewise (privat)

Viel näher an der eigenen Schrift als die Proben aus dem Dialog: echte Zeilen aus Notewise-Notizen als Vorlage.
Alles läuft am PC, die Daten liegen im ignorierten Ordner `daten/` und kommen nie ins Repo.

1. `tools/notewise_extract.py <export.zip> daten/seiten [Fächer …]` liest die Striche aus den PDF-Exporten.
   Notewise speichert jeden Strich als Vektorpfad, zerlegt ihn aber nach Stiftdruck in Stücke; die werden wieder verbunden.
2. `tools/line_sheet.py` erzeugt Zeilenbögen zum Abschreiben, `tools/add_abschrift.py` speichert die Abschriften.
3. `tools/make_hwm.py model daten/meine-handschrift.hwm` packt das Modell plus echte Zeilen als Vorlage in eine Datei.
4. Am Tablet: Einstellungen → „Eigenes Modell laden (.hwm)“. Die Datei bleibt nur im Browser des Tablets.

Nachtraining: `tools/train_hand.py` trainiert das Modell auf den abgeschriebenen Zeilen nach (PyTorch, GPU).
Notewise speichert die Punkte gleichmäßig entlang des Strichs, ohne Zeit; das Schreibtempo wird deshalb nach dem
Zwei-Drittel-Potenzgesetz nachgebildet. Erste Schicht und Attention („lesen“ den Text) bleiben eingefroren,
sonst verlernt das Modell, dem Text zu folgen. Mit ~730 Zeilen schreibt es deutlich ähnlicher als Modell + Vorlage
(`tools/compare_models.py` erzeugt den Vergleich). Kleine Umlaute schreibt das nachtrainierte Modell selbst (die Buchstaben
drumherum werden dann wie in echten Wörtern geformt, z. B. das b in „über“), die Pünktchen setzt aber die App; ß wird „ss“.

Lesbarkeit in der App: Zeilen werden in Stücken von ~22 Zeichen erzeugt; jedes Stück wird geprüft (übersprungene
oder verschmierte Buchstaben laut Attention, Reste der Vorlage, Riesensprünge, zu große Höhe) und bei Bedarf neu
erzeugt (bis zu 6 Versuche).

**Gründlich prüfen** (Einstellungen): Jede Variante eines Stücks wird zusätzlich von einer deutschen Texterkennung
(TrOCR, siehe `ocr/`) geprüft: Wie sicher erkennt sie im Bild jeden Wortteil des gewünschten Texts? So fallen einzelne
schlecht geformte Buchstaben auf, auch wenn man das Wort erraten könnte. Bei Stücken mit Großbuchstaben (die missraten
am häufigsten) liest sie zusätzlich frei. Die App nimmt die Variante mit der besten Note (4 Versuche, bei Bedarf bis 8).
Stücke beginnen möglichst nicht mit einem großgeschriebenen Wort. Das kostet einmalig ca. 65 MB Download und macht das
Schreiben deutlich langsamer (am PC ~75 s für zwei lange Zeilen).

Immer aktiv: Striche, die das Modell nach dem letzten Zeichen noch setzt (Haken hinter dem Satzpunkt), und einzelne
Punkte vor dem ersten Buchstaben werden entfernt.

Vorlagen auswählen: `tools/make_hwm.py daten/modell_v6 daten/kandidaten.hwm 16` baut eine Datei mit 16 Kandidaten,
`daten/prime_test.html` bewertet sie (wie gut Zeilenanfänge damit gelesen werden), `tools/pick_primes.py` übernimmt die besten.

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
