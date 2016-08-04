'use strict'

var _ = require('lodash');
var Promise = require('bluebird');
var fs = require('fs');
var path = require('path');
var moment = require('moment');

var icwsSub = require('./icws.sub');
var icws = require('../../lib/icwsModule');

/**
 * The __types to watch changes for.
 *
 * The keys matches function used for processing the data,
 * and the values matches the __type properties from ININ.
 */
var _typeIds = {
    updateInteractions: 'urn:inin.com:queues:queueContentsMessage',
    updateWorkstations: 'urn:inin.com:configuration.people:workgroupsMessage',
};

var __workstations = [];
var __activeInteractions = [];
var __finishedInteractions = [];

/**
 * The differance in milliseconds in comparison to the server.
 *
 * @type {Number}
 */
var __localTimeDiff = null;

/**
 * Array of time diffs between queueTime based on ININ data (queueDate - connectedDate)
 * and calculated queue time (__queueTime).
 *
 * Used for better handle current queue time.
 *
 * __localTimeDiff should be set to the mean value of the current day's diff.
 *
 * @type {Number[]}
 */
var __timeDiffs = [];

/**
 * The item which has been queueing the longest.
 * @type {{ queueTime: Number, queueLength: Number, id: Number }}
 */
var __longestQueueItem = { queueTime: 0, id: null, queueLength: 0 };

/**
 * All watcher methods, exactly matching the keys of _typeIds
 * to allow watch(...) to call any only via the key found from _typeIds.
 */
var watchers = {
    updateInteractions: updateInteractions,
    updateWorkstations: updateWorkstations,
}

/**
 * @param {Array} dataArr The array retuerned from polling
 */
function watch(dataArr) {
    // Find all functions to call
    var toCall = _.chain(_typeIds)
        .map(function (__type, key) {
            var _data = _.find(dataArr, function (data) { return _.get(data, '__type') === __type });
            // If there is *_data*, return an object where *key* is the key and *_data* is the value.
            return !!_data
                ? _.set({}, key, _data)
                : undefined;
        })
        .filter()
        .reduce(function (obj, current) { return _.assign({}, obj, current); }, {})
        .value();

    // Call every matched watcher
    _.forEach(toCall, function (val, key) {
        // Call the function if it's defined
        if (_.isFunction(watchers[key])) { watchers[key](val); }
    });

    _.forEach(__activeInteractions, updateCalculatedValues);
    updateQueueInfo();
}

/**
 * @param {Array} dataArr The array retuerned from polling
 */
function updateInteractions(data) {

    // Get all added interactions
    var _added = _.map(data.interactionsAdded, function (interaction) {
        // Return all of the following properties where there is a value.
        return _.reduce({
            id: _.get(interaction, 'interactionId'),
            type: _.get(interaction, 'attributes.Eic_ObjectType'),
            callType: getCallType(interaction),
            callDirection: getCallDirection(interaction),
            remoteAddress: _.get(interaction, 'attributes.Eic_RemoteAddress'),
            remoteId: _.get(interaction, 'attributes.Eic_RemoteId'),
            remoteName: _.get(interaction, 'attributes.Eic_RemoteName'),
            duration: _.get(interaction, 'attributes.Eic_ConnectDurationTime'),
            state: getState(interaction),
            stateVal: _.get(interaction, 'attributes.Eic_State'),
            workgroup: _.get(interaction, 'attributes.Eic_WorkgroupName'),
            userName: _.get(interaction, 'attributes.Eic_UserName'),
            startDate: getDate(interaction, 'Eic_InitiationTime'),
            endDate: getDate(interaction, 'Eic_TerminationTime'),
            queueDate: getDate(interaction, 'Eic_LineQueueTimestamp'),
            answerDate: getDate(interaction, 'Eic_AnswerTime'),
            connectedDate: getDate(interaction, 'Eic_ConnectTime'),
            referenceDate: new Date(),
        }, function (obj, value, key) {
            return !!value
                ? _.assign({}, obj, _.set({}, key, value))
                : obj;
        }, {});
    });

    // Get all changed interactions
    var _changed = _.map(data.interactionsChanged, function (interaction) {
        // Return all of the following properties where there is a value.
        return _.reduce({
            id: _.get(interaction, 'interactionId'),
            type: _.get(interaction, 'attributes.Eic_ObjectType'),
            callType: getCallType(interaction),
            callDirection: getCallDirection(interaction),
            remoteAddress: _.get(interaction, 'attributes.Eic_RemoteAddress'),
            remoteId: _.get(interaction, 'attributes.Eic_RemoteId'),
            remoteName: _.get(interaction, 'attributes.Eic_RemoteName'),
            duration: _.get(interaction, 'attributes.Eic_ConnectDurationTime'),
            state: getState(interaction),
            stateVal: _.get(interaction, 'attributes.Eic_State'),
            workgroup: _.get(interaction, 'attributes.Eic_WorkgroupName'),
            userName: _.get(interaction, 'attributes.Eic_UserName'),
            startDate: getDate(interaction, 'Eic_InitiationTime'),
            endDate: getDate(interaction, 'Eic_TerminationTime'),
            queueDate: getDate(interaction, 'Eic_LineQueueTimestamp'),
            answerDate: getDate(interaction, 'Eic_AnswerTime'),
            connectedDate: getDate(interaction, 'Eic_ConnectTime'),
        }, function (obj, value, key) {
            return !!value
                ? _.assign({}, obj, _.set({}, key, value))
                : obj;
        }, {});
    });

    // Get all removed interactions
    // NOTE: This is a simple array of ids
    var _removed = _.map(data.interactionsRemoved)

    // Handle added interactions
    if (_.some(_added)) {
        // Add them all
        __activeInteractions = __activeInteractions.concat(_.map(_added, function (interaction) {
            // If there is no queueTime but both queueDate and connectedDate exists, set queueTime
            if (_.isUndefined(interaction.queueTime) && !_.some([interaction.queueDate, interaction.connectedDate], _.isUndefined)) {
                interaction.queueTime = getDateDiff(interaction.queueDate, interaction.connectedDate, 'seconds');
            }

            return interaction;
        }));

        console.log('\nAdded interactions:');
        console.log(JSON.stringify(_added, null, 4));

        var _interactionPath = path.resolve(__dirname, '../../assets/icws/addedInteractions{date}.json'.replace('{date}', moment().format('HHmmss')));
        // fs.writeFileSync(_interactionPath, JSON.stringify(_activeInteractions, null, 4), 'utf8');
    }

    // Handle changes
    if (_.some(_changed)) {
        _.forEach(_changed, function (interaction) {
            var _interaction = _.find(__activeInteractions, { id: interaction.id });
            // Update the interaction
            if (_interaction) {
                // Get the position of the item
                var _index = _.indexOf(__activeInteractions, _interaction);
                // Merge the objects
                var _updated = _.assign({}, _interaction, interaction);

                // If there is no queueTime but both queueDate and connectedDate exists, set queueTime
                if (_.isUndefined(_updated.queueTime) && !_.some([_updated.queueDate, _updated.connectedDate], _.isUndefined)) {
                    _updated.queueTime = getDateDiff(_updated.queueDate, _updated.connectedDate, 'seconds');
                }

                // Splice in the updated version instead of the original item
                __activeInteractions.splice(_index, 1, _updated);
            }
        });

        console.log('\nChanged interactions');
        console.log(JSON.stringify(_changed, null, 4));

        var _interactionPath = path.resolve(__dirname, '../../assets/icws/interactions{date}.json'.replace('{date}', moment().format('HHmmss')));
        // fs.writeFileSync(_interactionPath, JSON.stringify(_activeInteractions, null, 4), 'utf8');
    }

    // Handle removed interactions
    if (_.some(_removed)) {
        var _removedItems = _.remove(__activeInteractions, function (interaction) { return !!~_removed.indexOf(interaction.id); });
        __finishedInteractions.concat(_removedItems);
        console.log('\nRemoved interactions:');
        console.log(JSON.stringify(_removedItems, null, 4));

        var _finishedInteractionsPath = path.resolve(__dirname, '../../assets/icws/removedInteractions{date}.json'.replace('{date}', moment().format('HHmmss')));
        // fs.writeFileSync(_finishedInteractionsPath, JSON.stringify(_removedItems, null, 4), 'utf8');
    }
}

/**
 * @param {Array} dataArr The array retuerned from polling
 */
function updateWorkstations(data) {
    // Get all added workstations
    var _added = _.map(data.added, function (workstation) {
        return {
            id: _.get(workstation, 'configurationId.id'),
            name: _.get(workstation, 'configurationId.displayName'),
            hasQueue: workstation.hasQueue,
            isActive: workstation.isActive,
        };
    });

    // Get all changed workstations
    var _changed = _.map(data.changed, function (workstation) {
        return {
            id: _.get(workstation, 'configurationId.id'),
            name: _.get(workstation, 'configurationId.displayName'),
            hasQueue: workstation.hasQueue,
            isActive: workstation.isActive,
        };
    });

    // Get all removed workstations
    var _removed = _.map(data.removed, function (workstation) { return _.get(workstation, 'configurationId.id'); });

    /**
     * TODO: Fill in the gap when there is no end date, but there's a start date and duration.
     *
     * TODO: push to some sort of database
     */

    if (_.some([_added, _changed, _removed]), _.some) {
        // Update _workStations
        __workstations = _.chain(__workstations)
            // Filter out removed workstations
            .filter(function (workstation) { return !!~_removed.indexOf(workstation); })
            // Filter out any modified workstations
            .filter(function (workstation) { return !_.find(_changed, { id: workstation.id }); })
            // Get the complete list of workstations
            .thru(function (workstations) { return workstations.concat(_added, _changed); })
            .value();

        console.log('There are now {num} workstations!'.replace('{num}', __workstations.length));

        // Get the ids to added workstations, if any, subscribe to their queues
        var _addedIds = _.map(_added, 'id');
        if (_.some(_addedIds)) {
            queueSub('subscribe', 'kugghuset-1', _addedIds);
        }

        // If removed, unsubscribe
        if (_.some(_removed)) {
            queueSub('unsubscribe', _removed);
        }
    }
}

/**
 * Returns a string of the current state.
 *
 * @param {Object} interaction The interaction object returned from ININ
 * @return {String} The state as a readable string instead of a single character
 */
function getState(interaction) {
    var _state;

    if (_.get(interaction, 'attributes.Eic_State') === 'A') {
        _state = 'Alerting agent'
    } else if (_.get(interaction, 'attributes.Eic_State') === 'C') {
        _state = 'On call';
    } else if (_.get(interaction, 'attributes.Eic_State') === 'H') {
        _state = 'On hold'
    } else if (_.get(interaction, 'attributes.Eic_State') === 'M') {
        _state = 'Voicemail';
    } else if (_.get(interaction, 'attributes.Eic_State') === 'O') {
        _state = 'Offering';
    } else if (_.get(interaction, 'attributes.Eic_State') === 'R') {
        _state = 'Awaiting answer';
    } else if (_.get(interaction, 'attributes.Eic_State') === 'P') {
        _state = 'Parked';
    } else if (_.get(interaction, 'attributes.Eic_State') === 'E') {
        _state = 'Call ended remotely';
    } else if (_.get(interaction, 'attributes.Eic_State') === 'I') {
        _state = 'Call ended locally';
    } else if (_.get(interaction, 'attributes.Eic_State') === 'S') {
        _state = 'Dialing';
    } else {
        _state = undefined;
    }

    return _state;
}

/**
 * @param {Object} interaction The interaction object returned from ININ
 * @return {String} The call type as a readable string.
 */
function getCallType(interaction) {
    var callType = _.get(interaction, 'attributes.Eic_CallType');// === 'E' ? 'external' : 'intercom',

    if (callType === 'E') {
        return 'external';
    } else if (callType === 'I') {
        return 'intercom';
    } else {
        return undefined;
    }
}

/**
 * @param {Object} interaction The interaction object returned from ININ
 * @return {String} The call direction as a readable string.
 */
function getCallDirection(interaction) {
    var callDirection = _.get(interaction, 'attributes.Eic_CallDirection');

    if (callDirection === 'I') {
        return 'inbound';
    } else if (callDirection === 'O') {
        return 'outbound';
    } else {
        return undefined;
    }
}

/**
 * @param {Object} interaction The interaction object returned
 * @param {String} dateType The type of date to return
 * @return {Date}
 */
function getDate(interaction, dateType) {
    var _dateString = _.get(interaction, 'attributes.' + dateType);

    // If there is no value, return null.
    if (!_dateString) {
        return null;
    }

    var _date;

    if (moment(new Date(_dateString)).isValid()) {
        _date = new Date(_dateString);
    } else if (moment(_dateString).isValid()) {
        _date = moment(_dateString).toDate();
    } else {
        _date = _dateString;
    }

    return _date;
}


/**
 * @param {Object} interaction The interaction object to get values from
 * @param {String} dateType1
 * @param {String} dateType2
 * @return {Number}
 */
function getDateDiff(date1, date2, granularity, skipAbs) {
    skipAbs = _.isBoolean(skipAbs) ? skipAbs : false;

    granularity = !!granularity ? granularity : 'seconds';

    if (!date2) {
        return -1;
    }

    return skipAbs
        ? moment(date1).diff(date2, granularity)
        : Math.abs(moment(date1).diff(date2, granularity));
}

/**
 * Updates the local time differance variable if it's either null or higher
 * than the diff between startDate and referenceDate of *interaction*.
 *
 * @param {Object} interaction The interaction object to get values from
 */
function updateLocalTimeDiff(interaction) {
    //  Get the differance
    var _timeDiffStart = getDateDiff(interaction.referenceDate, interaction.startDate, 'milliseconds', true);
    var _timeDiffEnd = !_.isUndefined(interaction.endDate) ? null : getDateDiff(interaction.referenceDate, interaction.endDate, 'milliseconds', true);

    var currentLocalDiff = __localTimeDiff;

    // If __localTimeDiff is null or higher, correct it with _timeDiff
    if (_.isNull(__localTimeDiff) || Math.abs(_timeDiffStart) < Math.abs(__localTimeDiff)) {
        __localTimeDiff = _timeDiffStart;
    }

    if (!_.isNull(_timeDiffEnd) && Math.abs(_timeDiffEnd) < Math.abs(__localTimeDiff)) {
        __localTimeDiff = _timeDiffEnd;
    }

    if (currentLocalDiff !== __localTimeDiff) {
        console.log('Local time differance updated to: {timediff} ms'.replace('{timediff}', __localTimeDiff));
    }
}

/**
 * Updates *interaction* with the following properties:
 * - inQueue (boolean value of whether the *interaction* is in queue or not.)
 * - _queueTime (calculated time diff between queueDate and Date.now or the actual queueTime (connectedDate - queueDate))
 * - __queueTime (calculated between queueDate and now, only set when the diff won't grow)
 *
 * @param {Object} interaction The interaction object to get values from
 * @param {Number} index Index of the interaction
 */
function updateCalculatedValues(interaction, index) {
    // Create a variable for _queueTime to be used.
    var _queueTime;

    // Update the inQueue property
    if (inQueue(interaction) && !interaction.inQueue) {
        interaction.inQueue = true;
    } else if (!inQueue(interaction) && interaction.inQueue) {
        interaction.inQueue = false;
    }

    // Set _queueTime to either the time diff returned form getInteractionQueueTime or the actual queueTime.
    if (interaction.inQueue) {
        _queueTime = getInteractionQueueTime(interaction);
    } else {
        _queueTime = interaction.queueTime || 0;
    }

    // Update the activeTime
    var _updated = _.assign(interaction, { _queueTime: _queueTime });

    // If __queueTime (calculated queueTime) is undefined and the *interaction* is not in queue, set __queueTime.
    if (_.isUndefined(_updated.__queueTime) && !interaction.inQueue) {
        interaction.__queueTime = getInteractionQueueTime(interaction);

        // Push the diff to __timeDiffs to store it.
        __timeDiffs.push(interaction.__queueTime - interaction._queueTime);
    }

    // Replace the item in the list.
    __activeInteractions.splice(index, 1, _updated);
}

/**
 * @param {Object} interaction The interaction object to get values from
 * @return {Boolean} Whether the *interaction* is assumed to be in queue or not.
 */
function inQueue(interaction) {
    return !_.some([
        _.isNumber(interaction.queueTime),
        _.isDate(interaction.endDate),
        interaction.callDirection !== 'inbound'
    ]);
}

/**
 * Updates the longest queue time and ID.
 */
function updateQueueInfo() {
    __longestQueueItem = _.chain(__activeInteractions)
        .filter(function (interaction) { return interaction.inQueue; })
        .map(function (interaction) { return _.assign({}, interaction, { _queueTime: getInteractionQueueTime(interaction) }) })
        .orderBy('_queueTime', 'desc')
        .thru(function (interactions) { return _.map(interactions, function (interaction) { return _.assign({}, interaction, { queueLength: interactions.length }); }); })
        .first()
        .thru(function (interaction) { return _.isUndefined(interaction) ? { id: null, queueTime: 0, queueLength: 0 } : { id: interaction.id, queueTime: interaction._queueTime, queueLength: interaction.queueLength } })
        .value();
}

/**
 *
 * @param {Object} interaction The interaction object to get values from
 * @return {Number}
 */
function getInteractionQueueTime(interaction) {
    // Should be less than.
    var _timeDiff = getDateDiff(interaction.referenceDate, interaction.queueDate, 'milliseconds', true);

    /**
     * TODO:
     * - Potentially add the time diff between __queueTime and (actual) queueTime to the diff
     *   for a closer value.
     */

    return moment(new Date()).diff(interaction.queueDate, 'seconds');
}

/****************
 * Subscriptions
 ****************/

/**
 * Subscribes or unsubscribes to workstations which are 'CSA'
 * with the subscription id *subId*.
 *
 * @param {String} action The action to run
 * @param {Number} subId Defaults to 1
 * @return {Promise}
 */
function workStationSub(action, subId) {
    subId = !_.isUndefined(subId)
        ? subId
        : 'kugghuset-1';

    var path = 'messaging/subscriptions/configuration/workgroups/:id'
        .replace(':id', subId)

    return /unsub/i.test(action)
        ? icwsSub.unsubscribe(path)
        : icwsSub.subscribe(path, {
            configurationIds: [
                '*',
                'CSA',
            ],
            properties: [
                'hasQueue',
                'isActive',
                'isWrapUpActive',
                'isCallbackEnabled',
                'isAcdEmailRoutingActive',
                'queueType',
            ],
            rightsFilter: 'view'
        });
}

/**
 * Enumeration of the various queueTypes
 */
var _queueTypes = {
    system: 0,
    user: 1,
    workgroup: 2,
    station: 3,
}

/**
 * Subscribes to all queus for *workstations*
 *
 * @param {String} action Should be either 'subscribe' or 'unsubscribe'
 * @param {String|Number} subId
 * @param {Array} workstations The workstation ids (firstname.lastname) to listen for.
 * @return {Promise}
 */
function queueSub(action, subId, workstations) {
    // Use default value of subId if undefined
    subId = !_.isUndefined(subId)
        ? subId
        : 'kugghuset-1';

    // Get all queueIds to subscribe to
    var _queueIds = _.chain(workstations)
        .map(function (workstation) { return { queueType: _queueTypes.workgroup, queueName: (workstation.id || workstation) }; })
        .filter(function (item) {
            // Filter out any not of interest workstations
            return !!~[
                'CSA',
                'Partner Service',
            ].indexOf(item.queueName);
        })
        // .uniqBy('queueType')
        .value();

    var _subPath = 'messaging/subscriptions/queues/:id'
        .replace(':id', subId)

    console.log('Subscribing to {num} queue(s)!'.replace('{num}', _queueIds.length));

    var _options = {
        queueIds: _queueIds,
        attributeNames: [
            'Eic_WorkgroupName',
            'Eic_InitiationTime',
            'Eic_TerminationTime',
            'Eic_AnswerTime',
            'Eic_ConnectTime',
            'Eic_LineQueueTimestamp',
            'Eic_CallId',
            'Eic_RemoteAddress',
            'Eic_RemoteId',
            'Eic_RemoteName',
            'Eic_UserName',
            'Eic_CallDirection',
            'Eic_ObjectType',
            'Eic_CallType',
            'Eic_State',
            'Eic_ConnectDurationTime',
        ],
        rightsFilter: 'view',
    };

    return /unsub/i.test(action)
        ? icwsSub.unsubscribe(_subPath)
        : icwsSub.subscribe(_subPath, _options);
}

/**
 * Sets the workgroup subscriptions up.
 *
 * @param {String} subId Subscription ID string, defaults ot 'kugghuset-1'
 * @return {Promise}
 */
function setup(subId) {
  // Use default value of subId if undefined
    subId = !_.isUndefined(subId)
        ? subId
        : 'kugghuset-1';

    return workStationSub('subscribe', subId);
}

module.exports = {
    watch: watch,
    setup: setup,
    getInteractions: function () {
        return {
            activeInteractions: __activeInteractions,
            finishedInteractions: __finishedInteractions,
        }
    },
    getLongestQueueItem: function () {
        return __longestQueueItem;
    },
}
