// yosys-worker.js
'use strict';

var runYosys    = null;
var YosysExit   = null;
var wasmLoaded  = false;
var pendingMessages = [];

function postError(msg, requestId) {
    self.postMessage({
        type:      'error',
        message:   String(msg),
        requestId: requestId
    });
}

// Load converter + WASM 
Promise.resolve()
    .then(function () {
        // importScripts is synchronous ie.sets self.yosys2digitaljs as global
        try {
            importScripts('/yosys2digitaljs-browser.js');
            if (typeof self.yosys2digitaljs === 'function') {
                console.log('[Worker] yosys2digitaljs core loaded');
            } else {
                console.warn('[Worker] yosys2digitaljs not found after importScripts');
            }
        } catch (e) {
            console.warn('[Worker] Could not load yosys2digitaljs core:', e.message);
            // non-fatal:- main thread will use manual fallback converter
        }

        return import('/yosys-bundle.js');
    })
    .then(function (mod) {
        runYosys  = mod.runYosys;
        YosysExit = mod.Exit || mod.YosysExit || null;

        if (typeof runYosys !== 'function') {
            throw new Error(
                'runYosys is not a function. Keys: ' +
                Object.keys(mod).join(', ')
            );
        }

        // warm-up run:- swallow error intentionally
        return runYosys([], {}, { synchronously: false }).catch(function () {});
    })
    .then(function () {
        wasmLoaded = true;
        console.log('[Worker] WASM ready');
        self.postMessage({ type: 'ready' });
        var msgs = pendingMessages.splice(0);
        msgs.forEach(function (e) { handleMessage(e); });
    })
    .catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        console.error('[Worker] Failed to load:', msg);
        postError('Failed to load Yosys WASM: ' + msg);
    });

//  Message queue 
self.onmessage = function (e) {
    if (!wasmLoaded) {
        pendingMessages.push(e);
        return;
    }
    handleMessage(e);
};

//Main handler
function handleMessage(e) {
    var verilog   = e.data.verilog;
    var files     = e.data.files;
    var topModule = e.data.topModule;
    var requestId = e.data.requestId;

    if (typeof runYosys !== 'function') {
        postError('Yosys WASM not ready.', requestId);
        return;
    }

    //  Building VFS input map 
    var inputFiles;
    var fileNames;

    if (files && typeof files === 'object' && Object.keys(files).length > 0) {
        // multi-file path to ffilter out empty files
        var filtered = {};
        Object.keys(files).forEach(function (name) {
            var content = String(files[name] || '').trim();
            if (content.length > 0) filtered[name] = content;
        });

        if (Object.keys(filtered).length > 0) {
            inputFiles = filtered;
            fileNames  = Object.keys(filtered);
            console.log('[Worker] Multi-file mode:', fileNames);
        } else {
            var code = String(verilog || '').trim();
            if (!code) { postError('Empty Verilog code.', requestId); return; }
            inputFiles = { 'input.v': code };
            fileNames  = ['input.v'];
        }
    } else {
        // single-file path
        var primaryCode = String(verilog || '').trim();
        if (!primaryCode || primaryCode.length < 5) {
            postError('Empty Verilog code received by worker.', requestId);
            return;
        }
        inputFiles = { 'input.v': primaryCode };
        fileNames  = ['input.v'];
    }

    // ── Validate ──────────────────────────────────────────────────────────
    var allCode = Object.values(inputFiles).join('\n');
    if (allCode.indexOf('module') === -1) {
        postError('No module declaration found in code.', requestId);
        return;
    }

    console.log('[Worker] Files:', fileNames);
    console.log('[Worker] Total code length:', allCode.length);
    console.log('[Worker] Top module:', topModule || '(auto-top)');

    // Build Yosys script 
    var hierarchyCmd = topModule
        ? 'hierarchy -top ' + topModule
        : 'hierarchy -auto-top';

    var readCmd = 'read_verilog ' + fileNames.join(' ');

    var script = [
        readCmd,
        hierarchyCmd,
        'proc', 'opt', 'memory', 'techmap', 'opt', 'clean',
        'write_json output.json'
    ].join('; ');

    console.log('[Worker] Script:', script);

    var stdoutChunks = [];
    var stderrChunks = [];

    runYosys(
        ['-p', script],
        inputFiles,
        {
            stdout: function (d) {
                if (d) stdoutChunks.push(
                    typeof d === 'string' ? d : new TextDecoder().decode(d)
                );
            },
            stderr: function (d) {
                if (d) stderrChunks.push(
                    typeof d === 'string' ? d : new TextDecoder().decode(d)
                );
            },
            synchronously: false,
        }
    ).then(function (result) {

        console.log('[Worker] Yosys finished. Result keys:',
            result instanceof Map
                ? Array.from(result.keys())
                : Object.keys(result || {})
        );

        // Extract output.json 
        var jsonRaw = (result instanceof Map)
            ? result.get('output.json')
            : (result && result['output.json']);

        if (!jsonRaw) {
            postError(
                'Yosys produced no output.json.\nStderr:\n' +
                stderrChunks.join('').slice(0, 800),
                requestId
            );
            return;
        }

        // Parsing Yosys JSON 
        var jsonText = (typeof jsonRaw === 'string')
            ? jsonRaw
            : new TextDecoder().decode(jsonRaw);

        var parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch (pe) {
            postError('Failed to parse Yosys JSON: ' + pe.message, requestId);
            return;
        }

        if (!parsed.modules || Object.keys(parsed.modules).length === 0) {
            postError(
                'No modules in Yosys output.\nStderr:\n' +
                stderrChunks.join('').slice(0, 800),
                requestId
            );
            return;
        }

        console.log('[Worker] Modules found:', Object.keys(parsed.modules));

        //  Convert using yosys2digitaljs core:-
        // If core is loaded successfully via importScripts, we use it
        // If not, send raw JSON and let main thread use manual fallback..
        var converted;
        var usedCore = false;

        if (typeof self.yosys2digitaljs === 'function') {
            try {
                converted = self.yosys2digitaljs(parsed, {});
                usedCore  = true;
                console.log('[Worker] Core conversion done. Devices:',
                    Object.keys(converted.devices || {}).length,
                    '| Connectors:', (converted.connectors || []).length
                );
            } catch (ce) {
                console.warn('[Worker] Core conversion failed, using fallback:', ce.message);
            }
        }

        if (!usedCore) {
            // raw JSON (main thread convertYosysToDigitalJs() handles it)
            self.postMessage({
                type:      'success',
                json:      parsed,
                converted: false,
                stdout:    stdoutChunks.join(''),
                stderr:    stderrChunks.join(''),
                requestId: requestId
            });
            return;
        }

        // already converted to DigitalJS format
        self.postMessage({
            type:      'success',
            json:      converted,
            converted: true,
            stdout:    stdoutChunks.join(''),
            stderr:    stderrChunks.join(''),
            requestId: requestId
        });

    }).catch(function (err) {
        var stderr = stderrChunks.join('').slice(0, 800);
        var msg;
        if (YosysExit && err instanceof YosysExit) {
            msg = 'Yosys exited with code ' + err.code + '\nStderr:\n' + stderr;
        } else {
            msg = (err && err.message ? err.message : String(err)) +
                  '\nStderr:\n' + stderr;
        }
        console.error('[Worker] Yosys error:', msg);
        postError(msg, requestId);
    });
}
