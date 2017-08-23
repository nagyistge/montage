var Montage = require("../../core").Montage,
    MontageContext = require("./montage-interpreter").MontageContext,
    MontageReviver = require("./montage-reviver").MontageReviver,
    Map = require("collections/map").Map,
    deprecate = require("../../deprecate");

var MontageDeserializer = exports.MontageDeserializer = Montage.specialize({

    _input: {
        value: null
    },

    _serialization: {
        value: null
    },

    serialization: {
        value: {
            get: function () {
                return this._serialization;
            }
        }
    },

    /**
     * @param {String|Object} serialization The serialization to deserialize.
     * May be in parsed object form or stringified json form.
     * @param {Require} _require
     * @param {Require} objectRequires
     */
    init: {
        value: function (serialization, _require, objectRequires, locationId, moduleContexts) {
            this._input = serialization;
            this._require = _require;
            moduleContexts = moduleContexts || new Map();
            this._reviver = new MontageReviver().init(_require, objectRequires, locationId, moduleContexts);

            return this;
        }
    },

    /**
     * @param {Object} instances Map-like object of external user objects to
     * link against the serialization.
     * @param {Element} element The root element to resolve element references
     * against.
     * @return {Promise}
     */
    deserialize: {
        value: function (instances, element) {
            if (typeof this._input === "string") {
                try {
                    this._serialization = JSON.parse(this._input);
                } catch (ex) {
                    return this._formatSerializationSyntaxError(this._input);
                }
            } else {
                this._serialization = this._input;
            }
            return new MontageContext()
                .init(this._serialization, this._reviver, instances, element, this._require)
                .getObjects();
        }
    },

    deserializeObject: {
        value: function(objects) {
            return this.deserialize(objects).then(function(objects) {
                return objects.root;
            });
        }
    },

    // TODO: Returns a promise if there are modules, undefined if there aren't,
    // and throws a sync error if there is an invalid location. Should be made
    // more consistent
    preloadModules: {
        value: function () {
            var serialization,
                reviver = this._reviver,
                moduleLoader = reviver.moduleLoader,
                object,
                locationId,
                locationDesc,
                module,
                promises = [];

            serialization = typeof this._input === "string" ? JSON.parse(this._input) : this._input;

            for (var label in serialization) {
                if (serialization.hasOwnProperty(label)) {
                    object = serialization[label];
                    locationId = object.prototype || object.object;

                    if (locationId) {
                        if (typeof locationId !== "string") {
                            throw new Error(
                                "Property 'object' of the object with the label '" +
                                label + "' must be a module id"
                            );
                        }
                        locationDesc = MontageReviver.parseObjectLocationId(locationId);
                        module = moduleLoader.getModule(locationDesc.moduleId, label);
                        if (Promise.is(module)) {
                            promises.push(module);
                        }
                    }
                }
            }

            if (promises.length > 0) {
                return Promise.all(promises);
            }
        }
    },

    getExternalObjectLabels: {
        value: function () {
            var serialization = this._serialization,
                labels = [];

            for (var label in serialization) {
                if (Object.keys(serialization[label]).length === 0) {
                    labels.push(label);
                }
            }

            return labels;
        }
    },

    _formatSerializationSyntaxError: {
        value: function (source) {
            var gutterPadding = "   ",
                origin = this._origin,
                message,
                error,
                lines,
                gutterSize,
                line;

            return require.async("jshint/dist/jshint").then(function (module) {
                if (!module.JSHINT(source)) {
                    error = module.JSHINT.errors[0];
                    lines = source.split("\n");
                    gutterSize = (gutterPadding + lines.length).length;
                    line = error.line - 1;

                    for (var i = 0, l = lines.length; i < l; i++) {
                        lines[i] = (new Array(gutterSize - (i + 1 + "").length + 1)).join(i === line ? ">" : " ") +
                            (i + 1) + " " + lines[i];
                    }
                    message = "Syntax error at line " + error.line +
                        (origin ? " from " + origin : "") + ":\n" +
                        error.evidence + "\n" + error.reason + "\n" +
                        lines.join("\n");
                } else {
                    message = "Syntax error in the serialization but not able to find it!\n" + source;
                }

                throw new Error(message);
            });
        }
    },

    // Deprecated members

    initWithObject: {
        value:  deprecate.deprecateMethod(void 0, function (serialization, _require, objectRequires, locationId, moduleContexts) {
            return this.init(serialization, _require, objectRequires, locationId, moduleContexts);
        }, "initWithObject", "init")
    },

    initWithObjectAndRequire: {
         value: deprecate.deprecateMethod(void 0, function (serialization, _require, objectRequires, locationId, moduleContexts) {
            return this.initWithObject(serialization, _require, objectRequires, locationId, moduleContexts);
        }, "initWithObjectAndRequire", "init")
    }

}, {
    // Adapted from mr/sandbox
    getModuleRequire: {
        value: function (parentRequire, moduleId) {
            var topId = parentRequire.resolve(moduleId);
            var module = parentRequire.getModuleDescriptor(topId);

            while (module.redirect || module.mappingRedirect) {
                if (module.redirect) {
                    topId = module.redirect;
                } else {
                    parentRequire = module.mappingRequire;
                    topId = module.mappingRedirect;
                }
                module = parentRequire.getModuleDescriptor(topId);
            }

            return module.require;
        }
    }
});


MontageDeserializer.defineDeserializationUnit = function (name, funktion) {
    MontageReviver.defineUnitReviver(name, funktion);
};

exports.deserialize = function (serializationString, _require) {
    return new MontageDeserializer().init(serializationString, _require).deserializeObject();
};
