/* global console */
var Montage = require("../../core").Montage,
    ValuesDeserializer = require("./values-deserializer").ValuesDeserializer,
    SelfDeserializer = require("./self-deserializer").SelfDeserializer,
    UnitDeserializer = require("./unit-deserializer").UnitDeserializer,
    ModuleReference = require("../../module-reference").ModuleReference,
    Alias = require("../alias").Alias, Bindings = require("../bindings"),
    Promise = require("../../promise").Promise,
    deprecate = require("../../deprecate"),
    ONE_ASSIGNMENT = "=",
    ONE_WAY = "<-",
    TWO_WAY = "<->";

require("../../shim/string");

var ModuleLoader = Montage.specialize({

    _require: {
        value: null
    },

    _objectRequires: {
        value: null
    },

    init: {
        value: function (_require, objectRequires) {
            if (typeof _require !== "function") {
                throw new Error("Function 'require' missing.");
            }
            if (typeof _require.location !== "string") {
                throw new Error("Function 'require' location is missing");
            }
            if (typeof objectRequires !== "object" &&
                typeof objectRequires !== "undefined") {
                throw new Error("Parameter 'objectRequires' should be an object.");
            }

            this._require = _require;
            this._objectRequires = objectRequires;

            return this;
        }
    },

    getExports: {
        value: function (_require, moduleId) {
            var module;

            // Transforms relative module ids into absolute module ids
            moduleId = _require.resolve(moduleId);
            module = _require.getModuleDescriptor(moduleId);

            while (module.redirect !== void 0) {
                module = _require.getModuleDescriptor(module.redirect);
            }

            if (module.mappingRedirect !== void 0) {
                return this.getExports(module.mappingRequire, module.mappingRedirect);
            }

            return module.exports;
        }
    },

    /**
     * @return {Promise}
     */
    getModule: {
        value: function (moduleId, label) {
            var objectRequires = this._objectRequires,
                _require,
                module;

            if (objectRequires && label in objectRequires) {
                _require = objectRequires[label];
            } else {
                _require = this._require;
            }

            module = this.getExports(_require, moduleId);

            if (!module) {
                module = _require.async(moduleId);
            }

            return Promise.resolve(module);
        }
    }
});

/**
 * @class MontageReviver
 */
var MontageReviver = exports.MontageReviver = Montage.specialize(/** @lends MontageReviver# */ {

    moduleLoader: {
        value: null
    },

    /**
     * @param {Require} _require The require object to load modules
     * @param {Object} objectRequires A dictionary indexed by object label with
     *        the require object to use for a specific object of the
     *        serialization.
     * @param {?Map} moduleContexts A map indexed by module ID with the
     *        MontageContext to use for a specific external object
     *        reference. Used to prevent circular references from creating
     *        an infinite loop.
     */
    init: {
        value: function (_require, objectRequires, locationId, moduleContexts) {
            this.moduleLoader = new ModuleLoader().init(_require, objectRequires);
            this._require = _require;
            this._locationId = locationId;
            this._moduleContexts = moduleContexts;
            return this;
        }
    },

    getTypeOf: {
        value: function (value) {
            var typeOf = typeof value;

            if (value === null) {
                return "null";
            } else if (Array.isArray(value)) {
                return "array";
            } else if (typeOf === "object" && Object.keys(value).length === 1) {
                if ("@" in value) {
                    return "reference";
                } else if ("/" in value) {
                    return "regexp";
                } else if ("#" in value) {
                    return "Element";
                } else if ("%" in value) {
                    return "Module";
                } else if (ONE_WAY in value || TWO_WAY in value || ONE_ASSIGNMENT in value) {
                    return "binding";
                } // else return typeOf -> object
            }

            return typeOf;
        }
    },

    _checkLabel: {
        value: function (label, isTemplateProperty) {
            if (isTemplateProperty && label[0] !== ":") {
                return new Error("Aliases can only be defined in template values (start with a colon (:)), \"" + label + "\".");
            } else if (!isTemplateProperty && label[0] === ":") {
                return new Error("Only aliases are allowed as template values (start with a colon (:), \"" + label + "\".");
            }
        }
    },

    reviveRootObject: {
        value: function (value, context, label) {
            var error,
                object,
                isAlias = "alias" in value;

            // Only aliases are allowed as template values, everything else
            // should be rejected as an error.
            error = this._checkLabel(label, isAlias);
            if (error) {
                return Promise.reject(error);
            }

            // Check if the optional "debugger" unit is set for this object
            // and stop the execution. This is intended to provide a certain
            // level of debugging in the serialization.
            if (value.debugger) {
                debugger; // jshint ignore:line
            }

            if ("value" in value) {
                // it's overriden by a user object
                if (context.hasUserObject(label)) {
                    object = context.getUserObject(label);
                    context.setObjectLabel(object, label);
                    return object;
                }

                var revivedValue = this.reviveValue(value.value, context, label);

                if (this.getTypeOf(value.value) === "Element") {
                    if (!Promise.is(revivedValue)) {
                        var montageObjectDesc = this.reviveObjectLiteral(value, context);
                        context.setBindingsToDeserialize(revivedValue, montageObjectDesc);
                        this.deserializeMontageObjectValues(
                            revivedValue,
                            montageObjectDesc.values || montageObjectDesc.properties, //deprecated
                            context
                        );
                        context.setUnitsToDeserialize(revivedValue, montageObjectDesc, MontageReviver._unitNames);
                    }
                }

                return revivedValue;

            } else if (Object.keys(value).length === 0) {
                // it's an external object
                if (context.hasUserObject(label)) {
                    object = context.getUserObject(label);
                    context.setObjectLabel(object, label);
                    return object;
                }

                return this.reviveExternalObject(value, context, label);
            } else if ("alias" in value) {
                return this.reviveAlias(value, context, label);
            } else {
                return this.reviveMontageObject(value, context, label);
            }
        }
    },

    reviveElement: {
        value: function (value, context, label) {
            var elementId = value["#"],
                element = context.getElementById(elementId);

            if (element) {
                if (label) {
                    context.setObjectLabel(element, label);
                }
                return element;
            } else {
                return Promise.reject(new Error("Element with id '" + elementId + "' was not found."));
            }
        }
    },

    reviveModule: {
        value: function (value, context, label) {
            var moduleId = value["%"],
                _require = context.getRequire();

            moduleId = _require.resolve(moduleId);
            var module = _require.getModuleDescriptor(moduleId);

            return new ModuleReference().initWithIdAndRequire(module.id, module.require);
        }
    },

    reviveAlias: {
        value: function (value, context, label) {
            var alias = new Alias();
            alias.value = value.alias;

            context.setObjectLabel(alias, label);
            return alias;
        }
    },

    /**
     * @return {Promise}
     */
    reviveMontageObject: {
        value: function (value, context, label) {
            var self = this;

            return Promise.resolve(value)
                .then(function (object) {
                    if (context.hasUserObject(label)) {
                        return context.getUserObject(label);
                    } else {
                        return self._getMontageObject(value, context, label);
                    }
                })
                .then(function (object) {
                    context.setObjectLabel(object, label);

                    if (object !== null && object !== void 0) {
                        object.isDeserializing = true;
                    }

                    if (value.bindings) {
                        deprecate.deprecationWarningOnce(
                            "'bindings' block is deprecated, use 'values' instead"
                        );
                    }
                    if (value.properties) {
                        deprecate.deprecationWarningOnce(
                            "'properties' block is deprecated, use 'values' instead"
                        );
                    }

                    context.setBindingsToDeserialize(object, value);
                    return Promise.resolve(self.reviveObjectLiteral(value, context))
                        .then(function (montageObjectDesc) {
                            if (typeof object.deserializeSelf === "function") {
                                return self.deserializeCustomMontageObject(object, montageObjectDesc, context, label);
                            } else {
                                return self.deserializeMontageObject(montageObjectDesc, object, context, label);
                            }
                        });
                });
        }
    },

    _getMontageObject: {
        value: function (value, context, label) {
            var locationId = value.prototype || value.object,
                locationDesc,
                objectName;
            if (!locationId) {
                return Promise.reject(new Error(
                    "Error deserializing " + JSON.stringify(value) +
                    ", might need \"prototype\" or \"object\" on label " +
                    JSON.stringify(label)
                ));
            }
            locationDesc = MontageReviver.parseObjectLocationId(locationId);
            objectName = locationDesc.objectName;
            return this._loadModule(locationDesc, context, label)
                .then(function (module) {
                    var object;
                    if ("prototype" in value) {
                        object = Object.create(module.prototype || module);
                        // TODO: For now we need this because we need to set
                        // isDeserilizing before calling didCreate.
                        object.isDeserializing = true;
                        if (typeof object.didCreate === "function") {
                            object.didCreate();
                        } else if (typeof object.constructor === "function") {
                            object.constructor();
                        }
                        return object;
                    } else {
                        return module;
                    }
                });
        }
    },

    _loadModule: {
        value: function (locationDesc, context, label) {
            var self = this,
                moduleId = locationDesc.moduleId,
                objectName = locationDesc.objectName;
            return this.moduleLoader
                .getModule(locationDesc.moduleId, label)
                .then(function (module) {
                    if (moduleId.endsWith(".mjson") || moduleId.endsWith(".meta")) {
                        if (moduleId && self._moduleContexts.has(moduleId)) {
                            // We have a circular reference. If we wanted to forbid circular
                            // references self is where we would throw an error.
                            return Promise.resolve(self._moduleContexts.get(moduleId)._objects.root);
                        } else {
                            if (self._locationId && !self._moduleContexts.has(self._locationId)) {
                                self._moduleContexts.set(self._locationId, context);
                            }
                            // TODO: Reviver instantiates Deserializer, not very clean.
                            // Maybe a deserialize module function could be passed in to
                            // the reviver in its constructor
                            return Promise.all([
                                    self.moduleLoader.getModule(moduleId, label),
                                    MontageReviver.getMontageDeserializer()
                                ])
                                .spread(function (module, MontageDeserializer) {
                                    var deserializer = new MontageDeserializer().init(
                                        module,
                                        MontageDeserializer.getModuleRequire(self._require, moduleId),
                                        void 0,
                                        moduleId,
                                        self._moduleContexts
                                    );
                                    return deserializer.deserializeObject();
                                });
                        }
                    } else if (moduleId.endsWith(".json")) {
                        return module;
                    } else { // JS
                        if (!(objectName in module)) {
                            throw new Error('Error deserializing "' + label +
                                '": object named "' + objectName + '"' +
                                ' was not found in "' + locationDesc.moduleId + '".' +
                                " Available objects are: " + Object.keys(module) + ".");
                        }
                        return module[objectName];
                    }
                });
        }
    },

    deserializeMontageObject: {
        value: function (montageObjectDesc, object, context, label) {
            var values;

            // Units are deserialized after all objects have been revived.
            // This happens at didReviveObjects.
            context.setUnitsToDeserialize(object, montageObjectDesc, MontageReviver._unitNames);
            values = this.deserializeMontageObjectValues(
                object,
                montageObjectDesc.values || montageObjectDesc.properties, //deprecated
                context
            );

            return object;
        }
    },

    deserializeMontageObjectProperties: {
        value: deprecate.deprecateMethod(void 0, function (object, values, context) {
            return this.deserializeMontageObjectValues(object, values, context);
        }, "deserializeMontageObjectProperties", "deserializeMontageObjectValues")
    },

    deserializeMontageObjectValues: {
        value: function (object, values, context) {
            var value;

            if (typeof object.deserializeProperties === "function" || typeof object.deserializeValues === "function") {
                var valuesDeserializer = new ValuesDeserializer()
                    .initWithReviverAndObjects(this, context);
                if (object.deserializeValues) {
                    value = object.deserializeValues(valuesDeserializer);
                } else { // deprecated
                    value = object.deserializeProperties(valuesDeserializer);
                }
            } else {
                /* jshint forin: true */
                for (var key in values) {
                /* jshint forin: false */
                    object[key] = values[key];
                }
            }

            return value;
        }
    },

    deserializeCustomMontageObject: {
        value: function (object, objectDesc, context, label) {
            var substituteObject;

            var selfDeserializer = new SelfDeserializer()
                .initWithObjectAndObjectDescriptorAndContextAndUnitNames(object, objectDesc, context, MontageReviver._unitNames);
            substituteObject = object.deserializeSelf(selfDeserializer);

            if (Promise.is(substituteObject)) {
                return substituteObject.then(function(substituteObject) {
                    context.setObjectLabel(substituteObject, label);
                    return substituteObject;
                });
            } else if (typeof substituteObject !== "undefined") {
                context.setObjectLabel(substituteObject, label);
                return substituteObject;
            } else {
                return object;
            }
        }
    },

    didReviveObjects: {
        value: function (objects, context) {
            var self = this;

            return Promise.all([
                this._deserializeBindings(context),
                this._deserializeUnits(context)
            ]).then(function () {
                self._invokeDeserializedFromSerialization(objects, context);
            });
        }
    },

    // TODO: can deserializeSelf make deserializedFromSerialization irrelevant?
    _invokeDeserializedFromSerialization: {
        value: function (objects, context) {
            var object;

            /* jshint forin: true */
            for (var label in objects) {
            /* jshint forin: false */

                object = objects[label];

                if (object !== null && object !== void 0) {
                    delete object.isDeserializing;
                }

                if (!context.hasUserObject(label)) {
                    // TODO: merge deserializedFromSerialization with
                    //       deserializedFromTemplate?
                    if (object && typeof object.deserializedFromSerialization === "function") {
                        object.deserializedFromSerialization(label);
                    }
                }
            }
        }
    },

    _deserializeBindings: {
        value: function (context) {
            var bindingsToDeserialize = context.getBindingsToDeserialize(),
                unitDeserializer = new UnitDeserializer(),
                bindingsToDeserializeDesc;

            if (bindingsToDeserialize) {
                try {
                    for (var i = 0, length = bindingsToDeserialize.length; i < length; i++) {
                        bindingsToDeserializeDesc = bindingsToDeserialize[i];
                        Bindings.deserializeObjectBindings(
                            unitDeserializer.initWithContext(context),
                            bindingsToDeserializeDesc.object,
                            bindingsToDeserializeDesc.bindings
                        );
                    }
                } catch (ex) {
                    return Promise.reject(ex);
                }
            }
        }
    },

    _deserializeUnits: {
        value: function (context) {
            var unitsToDeserialize = context.getUnitsToDeserialize(),
                units = MontageReviver._unitRevivers,
                unitDeserializer = new UnitDeserializer(),
                unitNames;

            try {
                for (var i = 0, unitsDesc; (unitsDesc = unitsToDeserialize[i]); i++) {
                    unitNames = unitsDesc.unitNames;

                    for (var j = 0, unitName; (unitName = unitNames[j]); j++) {
                        if (unitName in unitsDesc.objectDesc) {
                            unitDeserializer.initWithContext(context);
                            units[unitName](unitDeserializer, unitsDesc.object, unitsDesc.objectDesc[unitName]);
                        }
                    }
                }
            } catch (ex) {
                return Promise.reject(ex);
            }
        }
    },

    _createAssignValueFunction: {
        value: function(object, propertyName) {
            return function(value) {
                object[propertyName] = value;
            };
        }
    },

    getCustomObjectTypeOf: {
        writable: true,
        value: function() {}
    },

    reviveValue: {
        value: function(value, context, label) {
            var type = this.getTypeOf(value);

            if (type === "string" || type === "number" || type === "boolean" || type === "null" || type === "undefined") {
                return this.reviveNativeValue(value, context, label);
            } else if (type === "regexp") {
                return this.reviveRegExp(value, context, label);
            } else if (type === "reference") {
                return this.reviveObjectReference(value, context, label);
            } else if (type === "array") {
                return this.reviveArray(value, context, label);
            } else if (type === "object") {
                return this.reviveObjectLiteral(value, context, label);
            } else if (type === "Element") {
                return this.reviveElement(value, context, label);
            } else if (type === "binding") {
                return value;
            } else {
                return this._callReviveMethod("revive" + type, value, context, label);
            }
        }
    },

    reviveNativeValue: {
        value: function(value, context, label) {
            if (label) {
                context.setObjectLabel(value, label);
            }

            return value;
        }
    },

    reviveObjectLiteral: {
        value: function(value, context, label) {
            var item,
                promises = [];

            if (label) {
                context.setObjectLabel(value, label);
            }

            for (var propertyName in value) {
                if (value.hasOwnProperty(propertyName)) {
                    item = this.reviveValue(value[propertyName], context);

                    if (Promise.is(item)) {
                        promises.push(
                            item.then(this._createAssignValueFunction(
                                    value, propertyName)
                            )
                        );
                    } else {
                        value[propertyName] = item;
                    }
                }
            }

            if (promises.length === 0) {
                return value;
            } else {
                return Promise.all(promises).then(function() {
                    return value;
                });
            }
        }
    },

    reviveRegExp: {
        value: function(value, context, label) {

            var valuePath = value["/"],
                regexp = new RegExp(valuePath.source, valuePath.flags);

            if (label) {
                context.setObjectLabel(regexp, label);
            }

            return regexp;
        }
    },

    reviveObjectReference: {
        value: function(value, context, label) {
            var valuePath = value["@"],
                object = context.getObject(valuePath);

            return object;
        }
    },

    reviveArray: {
        value: function(value, context, label) {
            var item,
                promises = [];

            if (label) {
                context.setObjectLabel(value, label);
            }

            for (var i = 0, ii = value.length; i < ii; i++) {
                item = this.reviveValue(value[i], context);

                if (Promise.is(item)) {
                    promises.push(
                        item.then(this._createAssignValueFunction(value, i))
                    );
                } else {
                    value[i] = item;
                }
            }

            if (promises.length === 0) {
                return value;
            } else {
                return Promise.all(promises).then(function() {
                    return value;
                });
            }
        }
    },

    reviveExternalObject: {
        value: function(value, context, label) {
            return Promise.reject(
                new Error("External object '" + label + "' not found in user objects.")
            );
        }
    },

    _callReviveMethod: {
        value: function(methodName, value, context, label) {
            return this[methodName](value, context, label);
        }
    }

}, /** @lends MontageReviver. */ {
    _unitRevivers: {value: Object.create(null)},
    _unitNames: {value: []},

    _findObjectNameRegExp: {
        value: /([^\/]+?)(\.reel)?$/
    },
    _toCamelCaseRegExp: {
        value: /(?:^|-)([^-])/g
    },
    _replaceToCamelCase: {
        value: function (_, g1) { return g1.toUpperCase(); }
    },
    // Cache of location descriptors indexed by locationId
    _locationDescCache: {value: Object.create(null)},

    customObjectRevivers: {value: Object.create(null)},

    // Location Id is in the form of <moduleId>[<objectName>] where
    // [<objectName>] is optional. When objectName is missing it is derived
    // from the last path component of moduleId transformed into CamelCase.
    //
    // Example: "event/event-manager" has a default objectName of EventManager.
    //
    // When the last path component ends with ".reel" it is removed before
    // creating the default objectName.
    //
    // Example: "matte/ui/input-range.reel" has a default objectName of
    //          InputRange.
    //
    // @returns {moduleId, objectName}
    parseObjectLocationId: {
        value: function (locationId) {
            var locationDescCache = this._locationDescCache,
                locationDesc,
                bracketIndex,
                moduleId,
                objectName;

            if (locationId in locationDescCache) {
                locationDesc = locationDescCache[locationId];
            } else {
                bracketIndex = locationId.indexOf("[");

                if (bracketIndex > 0) {
                    moduleId = locationId.substr(0, bracketIndex);
                    objectName = locationId.slice(bracketIndex + 1, -1);
                } else {
                    moduleId = locationId;
                    this._findObjectNameRegExp.test(locationId);
                    objectName = RegExp.$1.replace(
                        this._toCamelCaseRegExp,
                        this._replaceToCamelCase
                    );
                }

                locationDesc = {
                    moduleId: moduleId,
                    objectName: objectName
                };
                locationDescCache[locationId] = locationDesc;
            }

            return locationDesc;
        }
    },

    defineUnitReviver: {
        value: function (name, funktion) {
            this._unitRevivers[name] = funktion;
            this._unitNames.push(name);
        }
    },

    getTypeOf: {
        value: function (value) {
            return this.prototype.getTypeOf.call(this, value);
        }
    },

    addCustomObjectReviver: {
        value: function(reviver) {
            var customObjectRevivers = this.customObjectRevivers;

            /* jshint forin: true */
            for (var methodName in reviver) {
            /* jshint forin: false */

                if (methodName === "getTypeOf") {
                    continue;
                }

                if (
                    typeof reviver[methodName] === "function" &&
                        methodName.substr(0, 5) === "revive"
                ) {
                    if (typeof customObjectRevivers[methodName] === "undefined") {
                        customObjectRevivers[methodName] = reviver[methodName].bind(reviver);
                    } else {
                        return new Error("Reviver '" + methodName + "' is already registered.");
                    }
                }
            }

            this.prototype.getCustomObjectTypeOf = this.makeGetCustomObjectTypeOf(reviver.getTypeOf);
        }
    },

    resetCustomObjectRevivers: {
        value: function() {
            this.customObjectRevivers = Object.create(null);
            this.prototype.getCustomObjectTypeOf = function() {};
        }
    },

    makeGetCustomObjectTypeOf:{
        value: function (getCustomObjectTypeOf) {
            var previousGetCustomObjectTypeOf = this.prototype.getCustomObjectTypeOf;

            return function(value) {
                return getCustomObjectTypeOf(value) || previousGetCustomObjectTypeOf(value);
            };
        }
    },

    //FIXME
    getMontageDeserializer: {
        value: function () {
            if (!this._montageDeserializerPromise) {
                // Need to require deserializer asynchronously because it depends on montage-interpreter, which
                // depends on this module, montage-reviver. A synchronous require would create a circular dependency.
                // TODO: Maybe this could be passed in from above instead of required here.
                this._montageDeserializerPromise = require.async("core/serialization/deserializer/montage-deserializer")
                    .then(function (deserializerModule) {
                        return deserializerModule.MontageDeserializer;
                    });
            }

            return this._montageDeserializerPromise;
        }
    }

});

if (typeof exports !== "undefined") {
    exports.MontageReviver = MontageReviver;
}
