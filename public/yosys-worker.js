// yosys-worker.js

'use strict';

var runYosys  = null;
var YosysExit = null;
var wasmLoaded = false;
var pendingMessages = [];

function postError(msg, requestId) {
    self.postMessage({
        type:      'error',
        message:   String(msg),
        requestId: requestId
    });
}

// Load WASM 
Promise.resolve()
    .then(function () {
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
        // warm-up run — intentionally swallow error
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
        console.error('[Worker] Failed to load Yosys WASM:', msg);
        postError('Failed to load Yosys WASM: ' + msg);
    });

self.onmessage = function (e) {
    if (!wasmLoaded) {
        pendingMessages.push(e);
        return;
    }
    handleMessage(e);
};

// ─ Main handler ─
function handleMessage(e) {
    var verilog   = e.data.verilog;
    var files     = e.data.files;
    var topModule = e.data.topModule;
    var requestId = e.data.requestId;

    if (typeof runYosys !== 'function') {
        postError('Yosys WASM not ready.', requestId);
        return;
    }

    // from buildFileMap() being called before editor is populated.
    var primaryCode = String(verilog || '').trim();

    console.log('[Worker] Received verilog length:', primaryCode.length);
    console.log('[Worker] Received files:', files ? Object.keys(files) : 'none');
    console.log('[Worker] Primary code preview:', primaryCode.substring(0, 100));

    // build from primary verilog string
    if (!primaryCode || primaryCode.length < 5) {
        postError('Empty Verilog code received by worker.', requestId);
        return;
    }

    var inputFiles = { 'input.v': primaryCode };
    var fileNames  = ['input.v'];

    // Validate:simple check, no stripping that could break things
    if (primaryCode.indexOf('module') === -1) {
        postError('No module declaration found in code.', requestId);
        return;
    }

    console.log('[Worker] Validation passed. Has module: true');

    // Build Yosys script
    var hierarchyCmd = topModule
        ? 'hierarchy -top ' + topModule
        : 'hierarchy -auto-top';

    var script = [
        'read_verilog input.v',
        hierarchyCmd,
        'proc',
        'opt',
        'memory',
        'techmap',
        'opt',
        'clean',
        'write_json output.json'
    ].join('; ');

    console.log('[Worker] Running script:', script);
    console.log('[Worker] Top module:', topModule || '(auto-top)');

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

        var jsonRaw = (result instanceof Map)
            ? result.get('output.json')
            : (result && result['output.json']);

        if (!jsonRaw) {
            var stderr = stderrChunks.join('');
            console.error('[Worker] No output.json. Stderr:', stderr);
            postError(
                'Yosys produced no output.json.\nStderr:\n' +
                stderr.slice(0, 800),
                requestId
            );
            return;
        }

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

        console.log('[Worker] Success. Modules:',
            Object.keys(parsed.modules));

        self.postMessage({
            type:      'success',
            json:      parsed,
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
