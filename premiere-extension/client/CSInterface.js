/**
 * Minimal CSInterface wrapper for Adobe CEP panels.
 * Provides the subset of Adobe's CSInterface.js needed by Resonance.
 */

var SystemPath = {
    APPLICATION:       "application",
    EXTENSION:         "extension",
    USER_DATA:         "userData",
    HOST_APPLICATION:  "hostApplication",
    SYSTEM_USER_DATA:  "systemUserData",
    COMMON_FILES:      "commonFiles",
    MY_DOCUMENTS:      "myDocuments",
    TEMP:              "temp"
};

function CSInterface() {}

/**
 * Evaluate an ExtendScript expression in the host application.
 * @param {string} script - The ExtendScript to evaluate
 * @param {function} callback - Receives the string result
 */
CSInterface.prototype.evalScript = function(script, callback) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.evalScript(script, callback || function() {});
    } else if (callback) {
        callback("EvalScript error: __adobe_cep__ not available");
    }
};

/**
 * Get a system path.
 * @param {string} pathType - One of the SystemPath constants
 * @returns {string}
 */
CSInterface.prototype.getSystemPath = function(pathType) {
    if (window.__adobe_cep__) {
        return window.__adobe_cep__.getSystemPath(pathType);
    }
    return "";
};

/**
 * Get the host environment object.
 * @returns {object}
 */
CSInterface.prototype.getHostEnvironment = function() {
    if (window.__adobe_cep__) {
        return JSON.parse(window.__adobe_cep__.getHostEnvironment());
    }
    return {};
};

/**
 * Open a URL in the default browser.
 * @param {string} url
 */
CSInterface.prototype.openURLInDefaultBrowser = function(url) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.openURLInDefaultBrowser(url);
    }
};

/**
 * Register an event listener for CSEvents.
 * @param {string} type - Event type
 * @param {function} listener - Handler
 */
CSInterface.prototype.addEventListener = function(type, listener) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.addEventListener(type, listener);
    }
};

/**
 * Remove an event listener.
 * @param {string} type
 * @param {function} listener
 */
CSInterface.prototype.removeEventListener = function(type, listener) {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.removeEventListener(type, listener);
    }
};
