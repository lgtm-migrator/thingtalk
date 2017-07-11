// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Almond
//
// Copyright 2016 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

function clean(name) {
    return name.replace(/_/g, ' ').replace(/([^A-Z])([A-Z])/g, '$1 $2').toLowerCase();
}

function displayLocation(_, loc) {
    if (loc.isAbsolute) {
        if (loc.display)
            return loc.display;
        else
            return '[Latitude: ' + Number(loc.lat).toFixed(3) + ' deg, Longitude: ' + Number(loc.lon).toFixed(3) + ' deg]'
    } else {
        switch (loc.relativeTag) {
        case 'current_location':
            return _("here");
        case 'home':
            return _("at home");
        case 'work':
            return _("at work");
        default:
            return loc.relativeTag;
        }
    }
}

function describeArg(_, arg) {
    if (arg.display)
        return arg.display;
    if (arg.isVarRef)
        return clean(arg.name.startsWith('v_') ? arg.name.substr('v_'.length) : arg.name);
    if (arg.isUndefined)
        return '____';
    if (arg.isEvent) {
        switch (arg.name) {
        case null:
            return _("the event");
        case 'title':
            return _("the event's title");
        case 'body':
            return _("the event's long description");
        default:
            return arg.name;
        }
    }
    if (arg.isLocation)
        return displayLocation(_, arg.value);
    if (arg.isString)
        return '"' + arg.value + '"';
    if (arg.isEntity) {
        if (arg.type === 'tt:username' || arg.type === 'tt:contact_name')
            return '@' + arg.value;
        if (arg.type === 'tt:hashtag')
            return '#' + arg.value;
        return arg.value;
    }
    if (arg.isNumber)
        return arg.value;
    if (arg.isEnum)
        return clean(arg.value);
    if (arg.isMeasure)
        return arg.value + ' ' + arg.unit;
    if (arg.isBoolean)
        return arg.value ? _("yes") : _("no");
    if (arg.isDate)
        return arg.value.toLocaleString();
    if (arg.isTime)
        return "%02d:%02d".format(arg.hour, arg.minute);

    return String(arg);
}

function describePrimitive(_, obj, primType) {
    var kind = obj.selector.kind;
    var owner = obj.selector.principal;
    var channel = obj.channel;
    var schema = obj.schema;

    var confirm;
    if (kind === 'remote' || kind.startsWith('__dyn')) {
        // special case internal sending/receiving
        if (channel === 'send')
            confirm = _("send it to $__principal");
        else if (channel === 'receive')
            confirm = _("you receive something from $__principal");
        else
            throw TypeError('Invalid @remote channel ' + channel);
    } else if (owner) {
        confirm = schema.confirmation_remote;
        if (!confirm)
            confirm = schema.confirmation;
        if (confirm === schema.confirmation)
            confirm = confirm.replace('your', describeArg(_, owner) + '\'s').replace('you', describeArg(dlg, owner));
        else
            confirm = confirm.replace('$__person', describeArg(_, owner));
    } else {
        confirm = schema.confirmation;
        if (obj.selector.device)
            confirm = confirm.replace('$__device', obj.selector.device.name);
        else
            confirm = confirm.replace('$__device', clean(kind));
    }

    let firstExtra = true;
    for (let inParam of obj.in_params) {
        let argname = inParam.name;
        let index = obj.schema.index[argname];
        let argcanonical = obj.schema.argcanonicals[index] || clean(argname);
        let value = describeArg(_, inParam.value);
        if (confirm.indexOf('$' + argname) >= 0) {
            confirm = confirm.replace('$' + argname, value);
        } else {
            if (argname.startsWith('__'))
                continue;
            if (kind === 'remote' || kind.startsWith('__dyn'))
                continue;
            if (inParam.value.isUndefined || inParam.value.isNull)
                continue;
            if (firstExtra) {
                confirm = confirm + _(" with %s equal to %s").format(argcanonical, value);
                firstExtra = false;
            } else {
                confirm = confirm + _(" and %s equal to %s");
            }
        }
    }

    function describeFilter(expr) {
        if (expr.isTrue || (expr.isAnd && expr.operands.length === 0))
            return _("true");
        if (expr.isFalse || (expr.isOr && expr.operands.length === 0))
            return _("false");
        if ((expr.isAnd || expr.isOr) && expr.operands.length === 1)
            return describeFilter(expr.operands[0]);
        if (expr.isAnd)
            return expr.operands.reduce((x, y) => _("%s and %s").format(describeFilter(x), describeFilter(y)));
        if (expr.isOr)
            return expr.operands.reduce((x, y) => _("%s and %s").format(describeFilter(x), describeFilter(y)));
        if (expr.isNot)
            return _("not %s").format(describeFilter(expr.expr));

        let filter = expr.filter;
        let index = obj.schema.index[argname];
        let argcanonical = obj.schema.argcanonicals[index] || clean(argname);
        let value =  describeArg(_, filter.value);
        switch (filter.operator) {
        case 'contains':
        case 'substr':
        case '=~':
            return _("%s contains %s").format(argcanonical, value);
        case 'in_array':
        case '~=':
            return _("%s contains %s").format(value, argcanonical);
        case '=':
            return _("%s is equal to %s").format(argcanonical, value);
        case '!=':
            return _("%s is not equal to %s").format(argcanonical, value);
        case '<':
            return _("%s is less than %s").format(argcanonical, value);
        case '>':
            return _("%s is greater than %s").format(argcanonical, value);
        case '<=':
            return _("%s is less than or equal to %s").format(argcanonical, value);
        case '>=':
            return _("%s is greater than or equal to %s").format(argcanonical, value);
        default:
            throw new TypeError('Invalid operator ' + filter.operator);
        }
    }

    if (primType === 'trigger')
        confirm = _("%s and %s").format(confirm, describeFilter(obj.filter));
    else if (primType === 'query')
        confirm = _("%s if %s").format(confirm, describeFilter(obj.filter));
    return confirm;
}

function describeRule(_, r) {
    var triggerDesc = r.trigger ? describePrimitive(_, r.trigger, 'trigger') : '';

    var queryDesc = r.queries.map((q) => describePrimitive(_, q, 'query')).join(_(" and then "));
    var actions = r.actions.filter((a) => !a.selector.isBuiltin);
    var actionDesc = actions.map((a) => describePrimitive(_, a, 'action')).join(_(" and "));

    var ruleDesc;
    if (actionDesc && queryDesc && triggerDesc)
        ruleDesc = _("%s then %s when %s").format(queryDesc, actionDesc, triggerDesc);
    else if (actionDesc && triggerDesc)
        ruleDesc = _("%s when %s").format(actionDesc, triggerDesc);
    else if (queryDesc && triggerDesc)
        ruleDesc = _("%s when %s").format(queryDesc, triggerDesc);
    else if (actionDesc && queryDesc)
        ruleDesc = _("%s then %s").format(queryDesc, actionDesc);
    else if (triggerDesc)
        ruleDesc = _("notify when %s").format(triggerDesc);
    else if (queryDesc)
        ruleDesc = queryDesc;
    else if (actionDesc)
        ruleDesc = actionDesc;
    if (r.once)
        ruleDesc += _(" (only once)");
    return ruleDesc;
}

function describeProgram(_, program) {
    return program.rules.map((r) => describeRule(_, r)).join(', ');
}

function capitalize(str) {
    return (str[0].toUpperCase() + str.substr(1)).replace(/[\-_]([a-z])/g, function(whole, char) { return char.toUpperCase(); }).replace(/[\-_]/g, '');
}

function capitalizeSelector(prim) {
    let kind = prim.selector.kind;
    let channel = prim.channel;
    if (kind === 'builtin')
        return capitalize(channel);
    else
        return capitalize(kind);
}

function getRuleName(_, r) {
    var triggerName = r.trigger ? capitalizeSelector(r.trigger) : '';

    var queryName = r.queries.map((q) => capitalizeSelector(q)).join(_(" to "));
    var actions = r.actions.filter((a) => !a.selector.isBuiltin);
    var actionName = actions.map((a) => capitalizeSelector(a)).join(_(" to "));
    if (actionName && queryName && triggerName)
        return _("%s to %s to %s").format(triggerName, queryName, actionName);
    else if (actionName && triggerName)
        return _("%s to %s").format(triggerName, actionName);
    else if (queryName && triggerName)
        return _("%s to %s").format(triggerName, queryName);
    else if (queryName && actionName)
        return _("%s to %s").format(queryName, actionName);
    else if (triggerName)
        return _("Monitor %s").format(triggerName);
    else if (actionName)
        return _("Execute %s").format(actionName);
    else
        return _("Query %s").format(queryName);
}

function getProgramName(_, program) {
    return program.rules.map((r) => getRuleName(_, r)).join(', ');
}

function pubDescribeArg(gettext, arg) {
    return describeArg(gettext.dgettext.bind(gettext, 'thingtalk'), arg);
}
function pubDescribeProgram(gettext, program) {
    return describeProgram(gettext.dgettext.bind(gettext, 'thingtalk'), program);
}
function pubGetProgramName(gettext, program) {
    return getProgramName(gettext.dgettext.bind(gettext, 'thingtalk'), program);
}

module.exports = {
    describeArg: pubDescribeArg,
    describeProgram: pubDescribeProgram,
    getProgramName: pubGetProgramName
}