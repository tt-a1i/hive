"use strict";
/**
 * Copyright (c) 2017, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assign = assign;
exports.loadNativeModule = loadNativeModule;
function assign(target) {
    var sources = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        sources[_i - 1] = arguments[_i];
    }
    sources.forEach(function (source) { return Object.keys(source).forEach(function (key) { return target[key] = source[key]; }); });
    return target;
}
function loadNativeModule(name) {
    // Resolve native code through the installed platform dependency. The Hive
    // package carries JS only; platform selection and binaries stay upstream.
    var path = require('node:path');
    var fs = require('node:fs');
    var platformRequire = require('node:module').createRequire(require.resolve('@lydell/node-pty'));
    var entry = platformRequire.resolve('@lydell/node-pty-' + process.platform + '-' + process.arch);
    var root = path.dirname(path.dirname(entry));
    var version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (version !== '1.2.0-beta.15') throw new Error('Review vendored node-pty JS before upgrading native dependency: ' + version);
    return platformRequire(path.join(root, 'lib/utils.js')).loadNativeModule(name);
}
//# sourceMappingURL=utils.js.map
