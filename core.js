const Developermonkey = {
    version: '1.1.0',
    runtime: 'DevTools',
    name: 'Developermonkey',
    build: '2026.03.07-19:43'
};

/*  ======== Core runtime (should be initialized once) ======== */

const DMRuntime = (() => {

    /* ---------- header parsing ---------- */

    function extractHeader(src) {
        const start = src.indexOf('// ==UserScript==');
        const end = src.indexOf('// ==/UserScript==');
        if (start === -1 || end === -1) return '';
        return src.slice(start, end + '// ==/UserScript=='.length);
    }

    function parseHeaderInfo(src) {

        const header = {};
        const includes = [];
        const excludes = [];
        const matches = [];

        const headerRegex = /\s*\/\/\s*@(\S+)\s+(.+)/;

        extractHeader(src).split('\n').forEach(line => {

            const m = headerRegex.exec(line);
            if (!m) return;

            const [, key, raw] = m;
            const value = raw.trim();

            if (key === 'include') { includes.push(value); return; }
            if (key === 'exclude') { excludes.push(value); return; }
            if (key === 'match') { matches.push(value); return; }

            header[key] = value;
        });

        header.includes = includes;
        header.excludes = excludes;
        header.matches = matches;

        return {
            script: header,
            scriptMetaStr: extractHeader(src),
            scriptHandler: Developermonkey.name,
            platform: navigator.userAgent,
            engine: Developermonkey
        };
    }

    function parseGrants(src) {

        const grants = new Set();
        const regex = /^\s*\/\/\s*@grant\s+(\S+)/gm;

        let m;

        while ((m = regex.exec(src)) !== null) {
            if (m[1] === 'none') continue;
            grants.add(m[1]);
        }

        return [...grants];
    }

    /* ---------- storage ---------- */

    function createStorage(info) {

        const scriptName = info.script.name || "unknown";
        const namespace = info.script.namespace || "";
        const prefix = `Developermonkey:${namespace}:${scriptName}:`;

        function GM_getValue(key, def) {
            const v = localStorage.getItem(prefix + key);
            return v === null ? def : JSON.parse(v);
        }

        function GM_setValue(key, value) {
            localStorage.setItem(prefix + key, JSON.stringify(value));
        }

        function GM_deleteValue(key) {
            localStorage.removeItem(prefix + key);
        }

        return {
            GM_getValue,
            GM_setValue,
            GM_deleteValue
        };
    }

    /* ---------- pattern matching ---------- */

    function patternToRegex(pattern) {
        let regex = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');

        return new RegExp(`^${regex}$`);
    }

    function matchesPattern(url, pattern) {
        return patternToRegex(pattern).test(url);
    }

    // handle regex @include
    function regexStringToArgs(string) {
        const regexRegex = /\/(.*)\/([gmisxuUDAJ]*)/;
        const exec = regexRegex.exec(string);
        return {
            source: exec?.[1] ?? null,
            flags: exec?.[2] ?? null
        }
    }

    function isValidRegex(pattern, flags = '') {
        try {
            new RegExp(pattern, flags);
            return true;
        } catch (e) {
            return false;
        }
    }

    function shouldRun(info) {
        const url = location.href;
        const meta = info.script;

        if (meta.matches.length) {
            const ok = meta.matches.some(p => matchesPattern(url, p));
            if (!ok) return false;
        }

        if (meta.includes.length) {
            const ok = meta.includes.some(p => matchesPattern(url, p));
            const regex = regexStringToArgs(meta.includes);
            const regexOk = isValidRegex(regex.source, regex.flags);
            if (!ok && !regexOk) return false;
        }

        if (meta.excludes.length) {
            const excluded = meta.excludes.some(p => matchesPattern(url, p));
            if (excluded) return false;
        }

        return true;
    }

    return {
        parseHeaderInfo,
        parseGrants,
        createStorage,
        shouldRun
    };

})();

function parseScript(script) {
    const grants = Object.freeze(DMRuntime.parseGrants(script));
    const info = Object.freeze(DMRuntime.parseHeaderInfo(script));

    return {
        grants,
        info
    };
}

async function runScript(script) {
    let src;
    let scriptFunc;

    if (typeof script === "function") {
        src = script.toString();
        scriptFunc = script;
    } else if (typeof script === "string") {
        src = script;
        scriptFunc = new Function(src);
    } else {
        throw new Error("runScript expects a function or string");
    }

    const parsed = parseScript(src);

    if (!DMRuntime.shouldRun(parsed.info))
        return;

    const prevGM = globalThis.GM;
    const GM = {};

    const storage = (() => {

        const scriptName = parsed.info.script.name || "unknown";
        const namespace = parsed.info.script.namespace || "";
        const prefix = `Developermonkey:${namespace}:${scriptName}:`;

        function GM_getValue(key, def) {
            const v = localStorage.getItem(prefix + key);
            return v === null ? def : JSON.parse(v);
        }

        function GM_setValue(key, value) {
            localStorage.setItem(prefix + key, JSON.stringify(value));
        }

        function GM_deleteValue(key) {
            localStorage.removeItem(prefix + key);
        }

        return { GM_getValue, GM_setValue, GM_deleteValue };

    })();

    const grantFuncs = {
        GM_info: parsed.info,
        ...storage
    };

    for (const grant of parsed.grants) {

        if (!(grant in grantFuncs)) continue;

        GM[grant.replace(/^GM_/, '')] = grantFuncs[grant];

        if (!(grant in globalThis))
            globalThis[grant] = grantFuncs[grant];
    }

    globalThis.GM = Object.freeze({ ...GM });

    try {
        await scriptFunc();
    } finally {

        if (prevGM === undefined)
            delete globalThis.GM;
        else
            globalThis.GM = prevGM;

        for (const grant of parsed.grants) {
            if (grant in globalThis && globalThis[grant] === grantFuncs[grant])
                delete globalThis[grant];
        }
    }
}

async function runFromGreasyfork(input) {
    let url;

    if (typeof input === "number") {
        url = `https://greasyfork.org/scripts/${input}`;
    } else {
        url = input;
    }

    if (url.endsWith(".user.js")) {

        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error("Failed to fetch script");

        const text = await res.text();
        return runScript(text);
    }

    const page = await fetch(url);
    if (!page.ok)
        throw new Error("Failed to fetch GreasyFork page");

    const html = await page.text();

    const m = html.match(/href="([^"]+\.user\.js)"/);

    if (!m)
        throw new Error("Could not find userscript install link");

    const scriptURL = new URL(m[1], url).href;

    const res = await fetch(scriptURL, { mode: 'cors' });
    if (!res.ok)
        throw new Error("Failed to fetch script");

    const scriptText = await res.text();

    return runScript(scriptText);
}
