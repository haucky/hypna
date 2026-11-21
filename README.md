# Hypna

Eine kleine Progressive Web App für Experimente mit der Hypnagogie, also dem Zustand kurz vor dem Einschlafen. Die Idee stammt von Edisons Stahlkugel und dem Dormio-Projekt des MIT Media Lab.

Du hältst das Handy locker in der Hand. Wenn du eindöst, erschlafft die Hand und das Handy kippt. Die App erkennt das über den Bewegungssensor, wartet kurz, spielt eine Frage ab und nimmt gleichzeitig deine Antwort auf. Danach nimmst du das Handy wieder in die Hand, und die nächste Runde beginnt.

Es gibt keinen Server, keine Transkription und keine Cloud. Audiodateien, Aufnahmen und Log bleiben in der IndexedDB deines Browsers.

## Benutzung

1. Öffne die Seite auf dem Handy und füge sie zum Home-Bildschirm hinzu (iOS: Teilen › Zum Home-Bildschirm).
2. Wähle unter **Audio** optional eine Inkubations-Datei und eine Frage-Datei (WAV, MP3, M4A …). Ohne Frage-Datei wird der Fragetext vorgelesen.
3. Häng das Handy ans Ladekabel, setz die Kopfhörer auf und leg dich hin.
4. Tippe auf **Start** und erlaube Bewegungssensor und Mikrofon.
5. Halte das Handy locker, zum Beispiel senkrecht mit aufgestütztem Unterarm. In den ersten Sekunden wird die Halte-Lage kalibriert.
6. Die Aufnahmen findest du danach unten in der App. Du kannst sie dort anhören oder herunterladen.

## Ablauf einer Runde

```
Inkubation → Kalibrieren → Wachen ──(Handy kippt > 40° für 1,5 s)──▶ Warten (30 s)
      ▲                                                                  │
      │                                    hält man das Handy wieder richtig: abbrechen
      │                                                                  ▼
 Handy aufnehmen & ruhig halten ◀── Pause ◀── Aufnahme (60 s) ◀── Frage abspielen
```

Alle Zeiten und Schwellen lassen sich unter **Ablauf** und **Erkennung** einstellen. Mit **Test-Auslösung** kannst du den Ablauf ausprobieren, ohne einzuschlafen. Der **Sicherheits-Timer** löst nach X Minuten auch ohne Erkennung aus.

## Wichtige Einschränkungen

- **Die App muss im Vordergrund und der Bildschirm an bleiben.** Browser pausieren Sensoren, sobald das Display gesperrt ist. Die App hält den Bildschirm über die Wake Lock API wach. Die **Sperre** macht ihn schwarz und schluckt alle Berührungen. Entsperren: den Punkt unten links in den Kreis oben rechts ziehen.
- **iOS:** Bewegungssensor und Wake Lock brauchen iOS 16.4 oder neuer. Die Berechtigung für den Bewegungssensor fragt Safari beim Start ab.
- **Bluetooth-Kopfhörer:** Sobald das Mikrofon offen ist, schalten viele Handys Bluetooth-Kopfhörer in den Headset-Modus. Die Tonqualität sinkt dann, und oft nimmt das Mikrofon der Kopfhörer auf statt das des Handys. Deshalb ist „Mikrofon die ganze Session offen halten“ standardmäßig an: So wechselt das Profil nicht mitten in der Nacht.
- **Ohne Kopfhörer** kann iOS bei offenem Mikrofon über die Hörmuschel statt über den Lautsprecher abspielen.
- Aufnahmen sind je nach Browser `.webm` (Android/Chrome) oder `.m4a` (iOS/Safari).

## Veröffentlichen mit GitHub Pages

Das Repo enthält nur statische Dateien und braucht keinen Build. Unter *Settings › Pages › Deploy from a branch* den Branch `main` und den Ordner `/ (root)` wählen. Sensoren und Mikrofon brauchen HTTPS, das bringt GitHub Pages mit.

Nach Änderungen die Versionsnummer `CACHE` in `sw.js` erhöhen, damit installierte Apps die neue Version laden.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `style.css` | Oberfläche |
| `app.js` | Ablauf, Audio, Aufnahme, Wake Lock, UI |
| `detector.js` | Einschlaf-Erkennung (reine Logik, ohne DOM) |
| `db.js` | IndexedDB-Speicher |
| `sw.js`, `manifest.webmanifest` | Offline-Fähigkeit und Installation |
| `test/detector.test.mjs` | Tests der Erkennung mit synthetischen Sensordaten |

Tests ausführen (Node 18+):

```
node --experimental-default-type=module test/detector.test.mjs
```

## Hinweis

Das ist ein Experimentier-Werkzeug, kein Medizinprodukt. Häufiges Wecken in der Einschlafphase kann den Schlaf stören. Benutz die App deshalb eher für Nickerchen oder einzelne Sessions und nicht jede Nacht.
