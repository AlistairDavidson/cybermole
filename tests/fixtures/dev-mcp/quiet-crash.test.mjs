// quiet-crash.test.mjs — the crash smoke fixture: a file that dies at
// import, before any test runs. node:test surfaces this as a file envelope
// failure with a file-scoped diagnostic (no leaf test:fail events) — the
// reporter's crash path (a failure entry for the file itself).
throw new Error('import exploded: nothing in this file ran');
