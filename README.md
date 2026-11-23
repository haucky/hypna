# Hypna – Audiotagebuch für den Halbschlaf

Eine Progressive Web App für das Einschlafen und Aufwachen. Du legst dich hin, tippst auf Start und sprichst, wann immer etwas auftaucht.

- **Nimmt nur auf, wenn du sprichst.** Stille, die länger als 5 Sekunden dauert, wird herausgeschnitten. Kürzere Pausen bleiben erhalten.
- **Fragt nach, wenn es lange still ist.** Nach 5 Minuten ohne Sprechen kommt leise eine Frage, etwa „Was ist gerade da?“. Danach hört die App weiter zu.
- **Die Fragen spricht Kyutai Pocket TTS**, direkt auf dem Handy und auf Deutsch. Vertont wird einmal, danach liegen die Audios lokal gespeichert vor.
- **Eine Aufnahme pro Session** als WAV. Die Nachfragen sind mit eingefügt, damit du beim Anhören weißt, worauf du geantwortet hast.

Es gibt keinen Server und keine Cloud. Aufnahmen, Nachfragen und Log liegen in der IndexedDB deines Browsers.

## Benutzung

1. Öffne die Seite auf dem Handy und füge sie zum Home-Bildschirm hinzu.
2. **Einmalig:** Trag die Nachfragen ein (eine pro Zeile) und tippe auf **Nachfragen vertonen**. Beim ersten Mal lädt das Handy das Sprachmodell, rund 180 MB von Hugging Face, am besten im WLAN. Danach bleibt es im Browser-Cache. Mit **Probe hören** testest du Stimme und Lebendigkeit.
3. Setz die Kopfhörer auf, häng das Handy ans Ladekabel und tippe auf **Start**. Der Bildschirm wird schwarz und ignoriert Berührungen.
4. Zum Beenden ziehst du den Punkt unten links in den Kreis oben rechts und tippst auf **Stopp & speichern**.

Bricht eine Session ab, weil der Akku leer ist oder die App geschlossen wurde, setzt die App die bis dahin gespeicherten Abschnitte beim nächsten Öffnen zu einer Aufnahme zusammen.

## Eigene Stimme

Unter **Nachfragen › Eigene Stimme** liest du einen vorgegebenen Text vor (10–20 s) oder wählst eine Audiodatei. Pocket TTS klont daraus die Stimme, und die Nachfragen klingen dann wie du. Sprich so, wie die Fragen später klingen sollen, also ruhig und eher leise. Beim ersten Klonen lädt die App zusätzlich den Stimmen-Encoder (ca. 40 MB). Die Stimmprobe bleibt lokal gespeichert, geklont wird bei jedem Vertonen neu.

Klone nur deine eigene Stimme oder eine, für die du die Erlaubnis hast.

## Einstellungen

| | Standard |
|---|---|
| Stille entfernen ab | 5 s |
| Nachfragen nach Stille von | 5 min |
| Höchstens Nachfragen pro Session | 6 |
| Reihenfolge | der Reihe nach |
| Empfindlichkeit | 12 dB über dem Grundrauschen |
| Glockenton vor der Nachfrage | an |

Der Pegelbalken zeigt den aktuellen Pegel, das Grundrauschen (grau) und die Schwelle (weiß). Wird Rauschen fälschlich als Sprache erkannt, stell die Empfindlichkeit höher. Wird leises Sprechen verpasst, stell sie niedriger.

## Wichtige Einschränkungen

- **Die App muss im Vordergrund bleiben**, der Bildschirm bleibt an (schwarz). Gesperrte Bildschirme pausieren das Mikrofon.
- **Bluetooth-Kopfhörer** schalten bei offenem Mikrofon oft in den Headset-Modus. Der Klang wird schlechter, und meist nimmt das Mikrofon der Kopfhörer auf.
- **Speicher:** Die Aufnahme ist WAV mit 16 kHz, also etwa 2 MB pro Minute *gesprochener* Zeit. Stille kostet nichts.
- Pocket TTS läuft auf GitHub Pages in einem einzelnen Thread, weil dort die nötigen Server-Header fehlen. Die Vertonung von sechs Fragen dauert auf einem Handy etwa eine halbe bis zwei Minuten.

## Technik

| Datei | Inhalt |
|---|---|
| `app.js` | Ablauf, Aufnahme, Nachfragen, Oberfläche |
| `audio-core.js` | Resampling, Sprach-Erkennung (VAD), Stille-Entfernung, WAV (ohne DOM, getestet) |
| `capture-worklet.js` | AudioWorklet für das Mikrofon |
| `tts.js` | Pocket TTS im Browser |
| `db.js` | IndexedDB |
| `vendor/` | gebündeltes [pocket-tts-onnx](https://github.com/thewh1teagle/pocket-tts-onnx) (CC BY 4.0) und [onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT) |
| `test/audio-core.test.mjs` | Tests mit synthetischem Audio |

Tests (Node 18+):

```
node --experimental-default-type=module test/audio-core.test.mjs
```

`vendor/` neu bauen:

```
npm i pocket-tts-onnx esbuild
npx esbuild node_modules/pocket-tts-onnx/dist/browser.js --bundle --format=esm --platform=browser --minify --outfile=vendor/pocket-tts.js
npx esbuild node_modules/pocket-tts-onnx/dist/worker.js --bundle --format=esm --platform=browser --minify \
  --external:module --external:fs --external:path --external:url --external:worker_threads --outfile=vendor/pocket-tts-worker.js
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{mjs,wasm} vendor/ort/
```

Nach Änderungen die Versionsnummer `CACHE` in `sw.js` erhöhen.

Die frühere Version mit Einschlaf-Erkennung über den Bewegungssensor steht in der Git-Historie (Commit `a29893a`).

## Hinweis

Das ist ein Experimentier-Werkzeug, kein Medizinprodukt.
