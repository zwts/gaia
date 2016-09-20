/* global debug, SimManager, LazyLoader, asyncStorage, deepCopy */
/* exported ConfigManager */
'use strict';

var ConfigManager = (function() {

  var today = new Date();

  var DEFAULT_SETTINGS = {
    'dataLimit': false,
    'dataLimitValue': 1,
    'dataLimitUnit': 'GB',
    'errors': {
      'INCORRECT_TOPUP_CODE': false,
      'BALANCE_TIMEOUT': false,
      'TOPUP_TIMEOUT': false
    },
    'fte': true,
    'waitingForBalance': null,
    'waitingForTopUp': null,
    'lastBalance': null,
    'lastBalanceRequest': null,
    'lastTopUpRequest': null,
    'lastDataUsage': {
      'timestamp': today,
      'start': today,
      'end': today,
      'today': today,
      'wifi': {
        'apps': {},
        'total': 0
      },
      'mobile': {
        'apps': {},
        'total': 0
      }
    },
    'lastTelephonyActivity': {
      'timestamp': today,
      'calltime': 0,
      'smscount': 0
    },
    'lastTelephonyReset': today,
    'lastDataReset': today,
    'lastCompleteDataReset': today,
    'lowLimit': false,
    'lowLimitThreshold': false,
    'lowLimitNotified': false,
    'zeroBalanceNotified': false,
    'dataUsageNotified': false,
    'nextReset': null,
    'plantype': 'postpaid',
    'resetTime': 1,
    'trackingPeriod': 'monthly',
    'isMobileChartVisible': true,
    'isWifiChartVisible': false
  };

  var CONFIG_CACHE = [];

  function getApplicationMode() {
    if (noConfigFound) {
      return 'DATA_USAGE_ONLY';
    }
    return settings.plantype.toUpperCase();
  }

  var configuration, configurationIndex, noConfigFound = false;
  function setConfig(newConfiguration) {
    configuration = newConfiguration;
    debug('Provider configuration done!');
  }

  // Load the operator configuration according to MCC_MNC pair
  function requestConfiguration(currentDataIcc, callback) {
    if (!currentDataIcc || !currentDataIcc.iccInfo) {
      console.error('No iccInfo available');
      return;
    }

    function returnConfiguration() {
      if (typeof callback === 'function') {
        callback(configuration);
      }
    }

    if (configuration) {
      setTimeout(function() {
        returnConfiguration();
      });
      return;
    }

    if (configurationIndex) {
      loadConfiguration(currentDataIcc, returnConfiguration);
    } else {
      loadConfigurationIndex(function onIndex() {
        loadConfiguration(currentDataIcc, returnConfiguration);
      });
    }
  }

  function loadConfiguration(currentDataIcc, callback) {
    var configFilePath = getConfigFilePath(currentDataIcc);
    if (CONFIG_CACHE[configFilePath]) {
      ConfigManager.setConfig(CONFIG_CACHE[configFilePath]);
      (typeof callback === 'function') && callback();
    } else {
      LazyLoader.load(configFilePath, function() {
        // configuration variable is set by calling setConfig() inside the
        // configuration file.
        CONFIG_CACHE[configFilePath] = configuration;
        (typeof callback === 'function') && callback();
      });
    }
  }

  function getConfigFilePath(currentDataIcc) {
    noConfigFound = false;
    var mcc = currentDataIcc.iccInfo.mcc;
    var mnc = currentDataIcc.iccInfo.mnc;
    var key = mcc + '_' + mnc;
    var configDir = configurationIndex[key];
    if (!configDir) {
      configDir = 'default';
      noConfigFound = true;
    }
    return 'js/config/' + configDir + '/config.js';
  }

  function loadConfigurationIndex(callback) {
    LazyLoader.getJSON('/js/config/index.json').then(function(json) {
      configurationIndex = json;
      if (configurationIndex === null) { // TODO Remove workaround when
					 // Bug 1069808 is fixed.
        console.error('Error loading the configuration index!' +
                      'Response from LazyLoader was null.');
        configurationIndex = {};
      }

      if (typeof callback === 'function') {
        setTimeout(function() {
          callback();
        });
      }
    }, function(error) {
      console.error('Error loading the configuration index! ' +
                    'Error code: ' + error);
      configurationIndex = {};
    });
  }

  // Let's serialize dates
  // XXX: To avoid random error:
  // "DataCloneError: The object could not be cloned."
  // {file:
  // "app://costcontrol.gaiamobile.org/shared/js/async_storage.js" line: 90}]
  Date.prototype.toJSON = function() {
    return {'__date__': this.toISOString()};
  };
  function settingsReviver(k, v) {
    if (v === null || typeof v !== 'object' || !v.hasOwnProperty('__date__')) {
      return v;
    }

    return new Date(v.__date__);
  }

  // Load stored settings
  var NO_ICCID = 'NOICCID';
  var settings;
  function requestSettings(iccIdInfo, callback) {
    var currentICCID = iccIdInfo || NO_ICCID;
    asyncStorage.getItem(currentICCID, function _wrapGetItem(localSettings) {
      // No entry: set defaults
      try {
        settings = JSON.parse(localSettings, settingsReviver);
      } catch (e) {
        // If we can't parse the settings, use the default ones
      }

      if (settings === null) {
        settings = deepCopy(DEFAULT_SETTINGS);
        debug('Storing default settings for ICCID:', currentICCID);
        asyncStorage.setItem(currentICCID, JSON.stringify(settings),
                             callback && callback.bind(null, settings));
      } else if (callback) {
        callback(settings);
      }
    });
  }

  // Provides vendor configuration and settings
  function requestAll(callback) {
    SimManager.requestDataSimIcc(function(dataSimIcc) {
      requestConfiguration(dataSimIcc.icc,
                           function _afterConfig(configuration) {
          requestSettings(dataSimIcc.iccId, function _afterSettings(settings) {
            if (callback) {
              callback(configuration, settings, dataSimIcc.iccId);
            }
          });
        }
      );
    });
  }

  // Produce a optionchange for the given option
  function dispatchOptionChange(name, value, oldValue, settings) {
    var event = new CustomEvent('optionchange', { detail: {
      name: name,
      value: value,
      oldValue: oldValue,
      settings: settings
    } });
    window.dispatchEvent(event);
    debug('Event optionchange dispatched for', name);
  }

  // Set setting options asynchronously and dispatch an event for every
  // affected option.
  function setOption(options, callback) {
    SimManager.requestDataSimIcc(function(dataSimIcc) {
      // If settings is not ready, load and retry
      if (!settings) {
        requestSettings(dataSimIcc.iccId, function _afterEnsuringSettings() {
          setOption(options, callback);
        });
        return;
      }

      // Store former values and update with new ones
      var formerValue = {};
      for (var name in options) {
        if (options.hasOwnProperty(name)) {
          formerValue[name] = settings[name];
          settings[name] = options[name];
        }
      }

      var currentICCID = dataSimIcc.iccId || NO_ICCID;
      asyncStorage.setItem(currentICCID, JSON.stringify(settings),
        function _onSet() {
          requestSettings(dataSimIcc.iccId, function _onSettings(settings) {
            for (var name in options) {
              if (options.hasOwnProperty(name)) {
                  dispatchOptionChange(name, settings[name], formerValue[name],
                                       settings);
              }
            }
            if (callback) {
              callback();
            }
          });
        }
      );
    });
  }

  // Part of the synchronous interface, return or set a setting.
  function syncOption(name, value) {
    var oldValue = settings[name];
    if (value === undefined) {
      return oldValue;
    }

    var update = {};
    update[name] = value;
    setOption(update);
  }

  var callbacks;
  // Function in charge of dispatch the events to the observers
  function callCallbacks(evt) {
    debug('Option', evt.detail.name, 'has changed!');
    var callbackCollection = callbacks[evt.detail.name] || [];
    for (var i = 0; i < callbackCollection.length; i++) {
      var callback = callbackCollection[i];
      if (callback) {
        callback(evt.detail.value, evt.detail.oldValue, evt.detail.name,
                 evt.detail.settings);
      }
    }
  }

  // Installs an observer to call when the setting has changed. It produces
  // an initial call to the callback unless you provide true as the last
  // parameter.
  function syncObserve(name, callback, avoidInitialCall) {
    debug('Installing observer for', name);

    // XXX: initialize this only if an observer is added
    if (callbacks === undefined) {
      callbacks = {};

      // Keeps the synchronization when the application need to communicate
      // instant information. Local storage event is used. The key sync is
      // read to determine which option has changed and a settingchange event
      // for that option is dispatched.
      window.addEventListener('storage', function _onSync(evt) {
        if (evt.key === 'sync') {
          var name = evt.newValue.split('#')[0];
          var oldValue = settings ? settings[name] : undefined;
          debug('Synchronization request for', name, 'received!');
          SimManager.requestDataSimIcc(function(dataSimIcc) {
            requestSettings(dataSimIcc.iccId,
                            function _onSettings(newSettings) {
              settings = newSettings;
              dispatchOptionChange(name, settings[name], oldValue, settings);
            });
          });
        }
      });

      window.addEventListener('optionchange', callCallbacks);
    }

    if (callbacks[name] === undefined) {
      callbacks[name] = [];
    }

    if (callbacks[name].indexOf(callback) < 0) {
      callbacks[name].push(callback);
      avoidInitialCall = avoidInitialCall || false;
      if (!avoidInitialCall && callback) {
        callback(settings[name], null, name, settings);
      }
    }
  }

  function syncRemoveObserver(name, callback) {
    var callbackCollection = callbacks[name];
    if (!callbackCollection) {
      return;
    }

    var index = callbackCollection.indexOf(callback);
    if (index > -1) {
      callbackCollection.splice(index, 1);
    }
  }

  function defaultValue(name) {
    return deepCopy(DEFAULT_SETTINGS[name]);
  }

  return {
    getApplicationMode: getApplicationMode,
    setConfig: setConfig,
    requestAll: requestAll,
    requestSettings: requestSettings,
    setOption: setOption,
    defaultValue: defaultValue,

    // XXX:These methods are the synchronous/cached interface. You need to
    // call requestAll() or requestSettings() to force cache renewal.
    // If you want to use observe() and option() as a getter, you need to setup
    // the cache by calling one of the former methods before. Only once is
    // enough.
    option: syncOption,
    observe: syncObserve,
    removeObserver: syncRemoveObserver,

    // XXX: Once loaded via requestConfiguration() / requestAll() it is ensured
    // it wont change so you can use this to access OEM confguration in a
    // synchronous fashion.
    get configuration() { return configuration; },
    // XXX: Bug 1126178-[CostControl] Remove ConfigManager.supportCustomizeMode
    // when the functionality is ready
    supportCustomizeMode: false
  };

}());