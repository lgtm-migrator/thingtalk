// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingTalk
//
// Copyright 2018-2020 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>

import assert from 'assert';

import * as Ast from '../ast';
import Type, { ArrayType, CompoundType } from '../type';
import * as Builtin from '../builtin/defs';

import * as JSIr from './jsir';
import {
    getRegister,
    typeForValue,
    compileCast,
    compileEvent,
    isRemoteSend,
    readResultKey,
    getExpressionParameters,
    EventType
} from './utils';
import Scope, { DeclarationScopeEntry, ProcedureScopeEntry } from './scope';
import type AppCompiler from './index';
import * as Ops from './ops';
import { compileBooleanExpressionToOp } from "./ast-to-ops";

type ArgMap = { [key : string] : JSIr.Register };

export default class OpCompiler {
    private _compiler : AppCompiler;
    private _irBuilder : JSIr.IRBuilder;
    private _forProcedure : boolean;
    private _globalScope : Scope;
    private _currentScope : Scope;
    private _varScopeNames : string[];

    constructor(compiler : AppCompiler,
                globalScope : Scope,
                irBuilder : JSIr.IRBuilder,
                forProcedure : boolean) {
        this._compiler = compiler;
        this._irBuilder = irBuilder;
        this._forProcedure = forProcedure;

        this._globalScope = globalScope;
        this._currentScope = new Scope(globalScope);
        this._varScopeNames = [];
    }

    private _compileTpFunctionCall(ast : Ast.Invocation|Ast.ExternalBooleanExpression) : [string, JSIr.AttributeMap, string] {
        if (!ast.__effectiveSelector) {
            // __effectiveSelector is used to turn dynamically declared classes for @remote
            // into just @remote
            console.error('WARNING: TypeCheck must set __effectiveSelector');
            ast.__effectiveSelector = ast.selector as Ast.DeviceSelector;
        }

        const attributes : JSIr.AttributeMap = {};
        if (ast.__effectiveSelector.id)
            attributes.id = ast.__effectiveSelector.id;
        // NOTE: "all" has no effect on the compiler, it only affects the dialog agent
        // whether it should slot-fill id or not
        // (in the future, this should probably be represented as id=$? like everywhere else...)

        for (const attr of ast.__effectiveSelector.attributes) {
            // attr.value cannot be a parameter passing in a program, so it's safe to call toJS here
            attributes[attr.name] = attr.value.toJS();
        }
        return [ast.__effectiveSelector.kind, attributes, ast.channel];
    }

    private _allocState() {
        return this._compiler._allocState();
    }

    private _compileOneInputParam(args : JSIr.Register,
                                  ast : Ast.Invocation|Ast.ExternalBooleanExpression,
                                  inParam : Ast.InputParam) {
        let reg = this.compileValue(inParam.value, this._currentScope);
        const schema = ast.schema;
        assert(schema);
        const ptype = schema.inReq[inParam.name] || schema.inOpt[inParam.name];
        reg = compileCast(this._irBuilder, reg, typeForValue(inParam.value, this._currentScope), ptype);
        this._irBuilder.add(new JSIr.SetKey(args, inParam.name, reg));
        return reg;
    }

    private _compileInputParams(ast : Ast.Invocation|Ast.ExternalBooleanExpression,
                                extra_in_params : Ast.InputParam[] = []) : [ArgMap, JSIr.Register] {
        const args = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.CreateObject(args));

        const argmap : ArgMap = {};
        for (const inParam of ast.in_params)
            argmap[inParam.name] = this._compileOneInputParam(args, ast, inParam);
        for (const inParam of extra_in_params)
            argmap[inParam.name] = this._compileOneInputParam(args, ast, inParam);
        return [argmap, args];
    }

    private _compileIterateQuery(list : JSIr.Register) : JSIr.Register {
        const iterator = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.AsyncIterator(iterator, list));

        const deviceAndResult = this._irBuilder.allocRegister();
        const loop = new JSIr.AsyncWhileLoop(deviceAndResult, iterator);
        this._irBuilder.add(loop);
        this._irBuilder.pushBlock(loop.body);

        return deviceAndResult;
    }

    private _compileFilterValue(expr : Ast.FilterValue,
                                currentScope : Scope) {
        const array = this.compileValue(expr.value, currentScope);

        const result = this._irBuilder.allocRegister();
        const element = this._irBuilder.allocRegister();

        assert(expr.type instanceof ArrayType);
        const elementtype = expr.type.elem;
        assert(elementtype instanceof Type);

        const filterop = new JSIr.ArrayFilterExpression(result, element, array);
        this._irBuilder.add(filterop);
        this._irBuilder.pushBlock(filterop.body);

        const newScope = new Scope(currentScope.parent);
        if (elementtype instanceof CompoundType) {
            for (const field in elementtype.fields) {
                if (field.indexOf('.') >= 0)
                    continue;
                readResultKey(this._irBuilder, newScope, element, field, field, elementtype.fields[field].type, false);
            }
        } else {
            newScope.set('value', {
                type: 'scalar',
                register: element,
                tt_type: elementtype,
                direction: 'output',
                isInVarScopeNames: false,
            });
        }

        const condition = this._compileFilter(compileBooleanExpressionToOp(expr.filter), newScope);
        this._irBuilder.add(new JSIr.ReturnValue(condition));

        this._irBuilder.popBlock();
        return result;
    }

    private _compileScalarExpression(ast : Ast.ComputationValue,
                                     scope : Scope) {
        const args = ast.operands.map((op) => this.compileValue(op, scope));
        const result = this._irBuilder.allocRegister();

        const opdef = Builtin.ScalarExpressionOps[ast.op];
        let opimpl : Builtin.OpImplementation = opdef;
        if (typeof opdef.overload === 'function')
            opimpl = opdef.overload(...(ast.overload as Type[]));

        if (opimpl.op)
            this._irBuilder.add(new JSIr.BinaryOp(args[0], args[1], opimpl.op, result));
        else
            this._irBuilder.add(new JSIr.FunctionOp(opimpl.fn as string, result, ...args));
        return result;
    }

    private _compileComparison(overload : Type[],
                               op : keyof typeof Builtin.BinaryOps,
                               lhs : JSIr.Register,
                               rhs : JSIr.Register,
                               into : JSIr.Register) {
        const opdef = Builtin.BinaryOps[op];
        let opimpl : Builtin.OpImplementation = opdef;
        if (typeof opdef.overload === 'function')
            opimpl = opdef.overload(...overload);

        if (opimpl.op)
            this._irBuilder.add(new JSIr.BinaryOp(lhs, rhs, opimpl.op, into));
        else if (opimpl.flip)
            this._irBuilder.add(new JSIr.BinaryFunctionOp(rhs, lhs, opimpl.fn as string, into));
        else
            this._irBuilder.add(new JSIr.BinaryFunctionOp(lhs, rhs, opimpl.fn as string, into));
    }

    compileValue(ast : Ast.Value, scope : Scope) : JSIr.Register {
        if (ast instanceof Ast.UndefinedValue)
            throw new Error('Invalid undefined value, should have been slot-filled');
        if (ast instanceof Ast.EventValue)
            return compileEvent(this._irBuilder, scope, ast.name as EventType);
        if (ast instanceof Ast.VarRefValue)
            return getRegister(ast.name, scope);

        if (ast instanceof Ast.ComputationValue)
            return this._compileScalarExpression(ast, scope);
        if (ast instanceof Ast.FilterValue)
            return this._compileFilterValue(ast, scope);
        if (ast instanceof Ast.ArrayFieldValue) {
            const array = this.compileValue(ast.value, scope);
            const result = this._irBuilder.allocRegister();
            this._irBuilder.add(new JSIr.MapAndReadField(result, array, ast.field));
            return result;
        }

        if (ast instanceof Ast.ArrayValue) {
            const array = this._irBuilder.allocRegister();
            this._irBuilder.add(new JSIr.CreateTuple(ast.value.length, array));

            for (let i = 0; i < ast.value.length; i++) {
                const v = ast.value[i];
                const reg = this.compileValue(v, scope);
                this._irBuilder.add(new JSIr.SetIndex(array, i, reg));
            }
            return array;
        }

        const reg = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.LoadConstant(ast, reg));
        return reg;
    }

    private _compileFilter(expr : Ops.BooleanExpressionOp, currentScope : Scope) {
        let cond = this._irBuilder.allocRegister();
        if (expr === Ops.BooleanExpressionOp.True) {
            this._irBuilder.add(new JSIr.LoadConstant(new Ast.Value.Boolean(true), cond));
        } else if (expr === Ops.BooleanExpressionOp.False) {
            this._irBuilder.add(new JSIr.LoadConstant(new Ast.Value.Boolean(false), cond));
        } else if (expr instanceof Ops.AndBooleanExpressionOp) {
            this._irBuilder.add(new JSIr.LoadConstant(new Ast.Value.Boolean(true), cond));
            for (const op of expr.operands) {
                const opv = this._compileFilter(op, currentScope);
                this._irBuilder.add(new JSIr.BinaryOp(cond, opv, '&&', cond));
            }
        } else if (expr instanceof Ops.OrBooleanExpressionOp) {
            this._irBuilder.add(new JSIr.LoadConstant(new Ast.Value.Boolean(false), cond));
            for (const op of expr.operands) {
                const opv = this._compileFilter(op, currentScope);
                this._irBuilder.add(new JSIr.BinaryOp(cond, opv, '||', cond));
            }
        } else if (expr instanceof Ops.NotBooleanExpressionOp) {
            const op = this._compileFilter(expr.expr, currentScope);
            this._irBuilder.add(new JSIr.UnaryOp(op, '!', cond));
        } else if (expr instanceof Ops.ExternalBooleanExpressionOp) {
            this._irBuilder.add(new JSIr.LoadConstant(new Ast.Value.Boolean(false), cond));

            const tryCatch = new JSIr.TryCatch("Failed to invoke get-predicate query");
            this._irBuilder.add(tryCatch);
            this._irBuilder.pushBlock(tryCatch.try);

            const [kind, attrs, fname] = this._compileTpFunctionCall(expr.ast as Ast.ExternalBooleanExpression);
            const list = this._irBuilder.allocRegister();
            const [argmap, args] = this._compileInputParams(expr.ast as Ast.ExternalBooleanExpression);
            const schema = expr.schema!;

            const hints = { projection: Array.from(getExpressionParameters(expr.filter.ast, schema)) };
            this._irBuilder.add(new JSIr.InvokeQuery(kind, attrs, fname, list, args, hints));

            const typeAndResult = this._compileIterateQuery(list);
            const [, result] = this._readTypeResult(typeAndResult);

            const nestedScope = new Scope(this._globalScope);
            for (const name in argmap) {
                nestedScope.set(name, {
                    type: 'scalar',
                    tt_type: schema.inReq[name] || schema.inOpt[name],
                    register: argmap[name],
                    direction: 'input',
                    isInVarScopeNames: false
                });
            }
            for (const outParam in schema.out) {
                const reg = this._irBuilder.allocRegister();
                this._irBuilder.add(new JSIr.GetKey(result, outParam, reg));
                nestedScope.set(outParam, {
                    type: 'scalar',
                    tt_type: schema.out[outParam],
                    register: reg,
                    direction: 'output',
                    isInVarScopeNames: false
                });
            }
            const ok = this._compileFilter(expr.filter, nestedScope);
            const ifStmt = new JSIr.IfStatement(ok);
            this._irBuilder.add(ifStmt);
            this._irBuilder.pushBlock(ifStmt.iftrue);
            this._irBuilder.add(new JSIr.LoadConstant(new Ast.Value.Boolean(true), cond));
            this._irBuilder.add(new JSIr.Break());
            this._irBuilder.popBlock();

            this._irBuilder.popBlock(); // for-of
            this._irBuilder.popBlock(); // try-catch
        } else if (expr instanceof Ops.ComparisonSubqueryBooleanExpressionOp) {
            this._irBuilder.add(new JSIr.LoadConstant(new Ast.Value.Boolean(false), cond));

            const op = expr.operator;
            const overload = expr.overload as Type[];
            let lhs = this.compileValue(expr.lhs, currentScope);
            lhs = compileCast(this._irBuilder, lhs, typeForValue(expr.lhs, currentScope), overload[0]);

            const blockStack = this._irBuilder.saveStackState();
            const tmpScope = this._currentScope;
            this._currentScope = new Scope(currentScope);

            this._compileTable(expr.subquery); // const list = invokeQuery(); for(const iter of list) { [...]

            const ok = this._irBuilder.allocRegister();
            let rhs = this.compileValue(expr.rhs, this._currentScope);
            rhs = compileCast(this._irBuilder, rhs, typeForValue(expr.rhs, this._currentScope), overload[1]);
            this._compileComparison(overload, op, lhs, rhs, ok);

            const ifStmt = new JSIr.IfStatement(ok);
            this._irBuilder.add(ifStmt);
            this._irBuilder.pushBlock(ifStmt.iftrue);
            this._irBuilder.add(new JSIr.LoadConstant(new Ast.Value.Boolean(true), cond));
            this._irBuilder.add(new JSIr.Break());
            this._irBuilder.popBlock();

            this._currentScope = tmpScope;
            this._irBuilder.popTo(blockStack);
        } else if (expr instanceof Ops.AtomBooleanExpressionOp) {
            const op = expr.operator;
            const overload = expr.overload as Type[];
            const lhs = this.compileValue(expr.lhs, currentScope);
            const castedlhs = compileCast(this._irBuilder, lhs, typeForValue(expr.lhs, currentScope), overload[0]);
            const rhs = this.compileValue(expr.rhs, currentScope);
            const castedrhs = compileCast(this._irBuilder, rhs, typeForValue(expr.rhs, currentScope), overload[1]);
            this._compileComparison(overload, op, castedlhs, castedrhs, cond);
            cond = compileCast(this._irBuilder, cond, overload[2], Type.Boolean);
        } else {
            throw new Error('Unsupported boolean expression ' + expr);
        }
        return cond;
    }

    private _setInvocationOutputs(schema : Ast.FunctionDef,
                                  argmap : ArgMap,
                                  typeAndResult : JSIr.Register) {
        const [outputType, result] = this._readTypeResult(typeAndResult);

        this._currentScope = new Scope(this._globalScope);
        this._varScopeNames = [];
        this._currentScope.set('$outputType', {
            type: 'scalar',
            tt_type: null,
            direction: 'special',
            register: outputType,
            isInVarScopeNames: false
        });
        this._currentScope.set('$output', {
            type: 'scalar',
            tt_type: null,
            direction: 'special',
            register: result,
            isInVarScopeNames: false
        });

        for (const arg in argmap) {
            this._currentScope.set(arg, {
                type: 'scalar',
                tt_type: schema.inReq[arg] || schema.inOpt[arg],
                register: argmap[arg],
                direction: 'input',
                isInVarScopeNames: false
            });
            // note: input parameters && __result do not participate in varScopeNames (which is used to
            // compare tuples for equality in monitor())
        }

        for (const outArg of schema.iterateArguments()) {
            if (outArg.direction !== Ast.ArgDirection.IN_OPT || outArg.name in argmap)
                continue;
            if (outArg.name.indexOf('.') >= 0)
                continue;
            readResultKey(this._irBuilder, this._currentScope, result, outArg.name, outArg.name, outArg.type, false);
            // note: input parameters && __result do not participate in varScopeNames (which is used to
            // compare tuples for equality in monitor())
        }

        // if the schema has an explicit __response argument (which is the case for @remote stuff
        // which needs to carry over __response), we do not override it here
        if (!schema.hasArgument('__response'))
            readResultKey(this._irBuilder, this._currentScope, result, '__response', '__response', Type.String, false);

        for (const outArg of schema.iterateArguments()) {
            if (outArg.direction !== Ast.ArgDirection.OUT)
                continue;
            if (outArg.name.indexOf('.') >= 0)
                continue;
            readResultKey(this._irBuilder, this._currentScope, result, outArg.name, outArg.name, outArg.type, true);
            this._varScopeNames.push(outArg.name);
        }
    }

    private _compileInvokeSubscribe(streamop : Ops.InvokeSubscribeStreamOp) {
        const tryCatch = new JSIr.TryCatch("Failed to invoke trigger");
        this._irBuilder.add(tryCatch);
        this._irBuilder.pushBlock(tryCatch.try);

        const [kind, attrs, fname] = this._compileTpFunctionCall(streamop.invocation);
        const [argmap, argmapreg] = this._compileInputParams(streamop.invocation);
        const hints = this._compileInvocationHints(streamop.invocation, streamop.hints);

        const iterator = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.InvokeMonitor(kind, attrs, fname, iterator, argmapreg, hints));

        const result = this._irBuilder.allocRegister();
        const loop = new JSIr.AsyncWhileLoop(result, iterator);
        this._irBuilder.add(loop);
        this._irBuilder.pushBlock(loop.body);

        this._setInvocationOutputs(streamop.invocation.schema!, argmap, result);
    }

    private _compileTimer(streamop : Ops.TimerStreamOp) {
        const tryCatch = new JSIr.TryCatch("Failed to invoke timer");
        this._irBuilder.add(tryCatch);
        this._irBuilder.pushBlock(tryCatch.try);

        const iterator = this._irBuilder.allocRegister();
        const base = this.compileValue(streamop.base, this._currentScope);
        const interval = this.compileValue(streamop.interval, this._currentScope);
        let frequency = null;
        if (streamop.frequency !== null)
            frequency = this.compileValue(streamop.frequency, this._currentScope);

        this._irBuilder.add(new JSIr.InvokeTimer(iterator, base, interval, frequency));

        const outputType = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.LoadConstant(null, outputType));

        const result = this._irBuilder.allocRegister();
        const loop = new JSIr.AsyncWhileLoop(result, iterator);
        this._irBuilder.add(loop);
        this._irBuilder.pushBlock(loop.body);

        this._currentScope = new Scope(this._globalScope);
        this._currentScope.set('$outputType', {
            type: 'scalar',
            tt_type: null,
            register: outputType,
            direction: 'special',
            isInVarScopeNames: false
        });
        this._currentScope.set('$output', {
            type: 'scalar',
            tt_type: null,
            register: result,
            direction: 'special',
            isInVarScopeNames: false
        });
    }

    private _compileAtTimer(streamop : Ops.AtTimerStreamOp) {
        const tryCatch = new JSIr.TryCatch("Failed to invoke at-timer");
        this._irBuilder.add(tryCatch);
        this._irBuilder.pushBlock(tryCatch.try);

        const iterator = this._irBuilder.allocRegister();
        const timeArray = this._irBuilder.allocRegister();

        this._irBuilder.add(new JSIr.CreateTuple(streamop.time.length, timeArray));
        for (let i = 0; i < streamop.time.length; i++) {
            const time = this.compileValue(streamop.time[i], this._currentScope);
            this._irBuilder.add(new JSIr.SetIndex(timeArray, i, time));
        }

        let expiration_date = null;
        if (streamop.expiration_date !== null)
            expiration_date = this.compileValue(streamop.expiration_date, this._currentScope);
        this._irBuilder.add(new JSIr.InvokeAtTimer(iterator, timeArray, expiration_date));

        const outputType = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.LoadConstant(null, outputType));

        const result = this._irBuilder.allocRegister();
        const loop = new JSIr.AsyncWhileLoop(result, iterator);
        this._irBuilder.add(loop);
        this._irBuilder.pushBlock(loop.body);

        this._currentScope = new Scope(this._globalScope);
        this._currentScope.set('$outputType', {
            type: 'scalar',
            tt_type: null,
            register: outputType,
            direction: 'special',
            isInVarScopeNames: false
        });
        this._currentScope.set('$output', {
            type: 'scalar',
            tt_type: null,
            register: result,
            direction: 'special',
            isInVarScopeNames: false
        });
    }

    private _compileInvocationHints(invocation : Ast.Invocation,
                                    hints : Ops.QueryInvocationHints) {
        if (!invocation.schema!.is_list) {
            // if the invocation is not a list, filter, sort and limit are not applicable
            return {
                projection: [...hints.projection],
                filter: undefined,
                sort: undefined,
                limit: undefined
            };
        }

        const optimized = hints.filter.optimize();

        let clauses : Ast.BooleanExpression[] = [];
        if (optimized instanceof Ast.AndBooleanExpression)
            clauses = optimized.operands;
        else
            clauses = [optimized];

        const toCompile = clauses.filter((c : Ast.BooleanExpression) => c instanceof Ast.AtomBooleanExpression) as Ast.AtomBooleanExpression[];
        if (toCompile.length === 0) {
            return {
                projection: [...hints.projection],
                filter: undefined,
                sort: hints.sort,
                limit: hints.limit
            };
        }

        const filterArray = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.CreateTuple(toCompile.length, filterArray));
        for (let i = 0; i < toCompile.length; i++) {
            const clause = toCompile[i];
            // a bit ugly but it works and avoids a ton of temporaries
            const clauseTuple = this.compileValue(new Ast.Value.Array([
                new Ast.Value.String(clause.name),
                new Ast.Value.String(clause.operator),
                clause.value
            ]), this._currentScope);
            this._irBuilder.add(new JSIr.SetIndex(filterArray, i, clauseTuple));
        }

        return {
            projection: [...hints.projection],
            filter: filterArray,
            sort: hints.sort,
            limit: hints.limit
        };
    }

    private _compileInvokeGet(tableop : Ops.InvokeGetTableOp) {
        const tryCatch = new JSIr.TryCatch("Failed to invoke query");
        this._irBuilder.add(tryCatch);
        this._irBuilder.pushBlock(tryCatch.try);

        const [kind, attrs, fname] = this._compileTpFunctionCall(tableop.invocation);
        const [argmap, argmapreg] = this._compileInputParams(tableop.invocation, tableop.extra_in_params);
        const hints = this._compileInvocationHints(tableop.invocation, tableop.hints);
        const list = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.InvokeQuery(kind, attrs, fname, list, argmapreg, hints));

        const result = this._compileIterateQuery(list);
        this._setInvocationOutputs(tableop.invocation.schema!, argmap, result);
    }

    private _compileVarRefInputParams(decl : DeclarationScopeEntry|ProcedureScopeEntry,
                                      in_params : Ast.InputParam[]) {
        const in_argmap : ArgMap = {};
        for (const inParam of in_params) {
            let reg = this.compileValue(inParam.value, this._currentScope);
            const ptype = decl.schema.getArgType(inParam.name);
            assert(ptype);
            reg = compileCast(this._irBuilder, reg, typeForValue(inParam.value, this._currentScope), ptype);
            in_argmap[inParam.name] = reg;
        }

        return decl.args.map((arg : string) => in_argmap[arg]);
    }

    private _compileInvokeGenericVarRef(op : Ops.InvokeVarRefTableOp|Ops.InvokeVarRefStreamOp|Ast.VarRefAction|Ast.VarRefTable) {
        const decl = this._currentScope.get(op.name);
        assert(decl.type === 'declaration' || decl.type === 'procedure');
        let fnreg;
        if (decl.register !== null) {
            fnreg = decl.register;
        } else {
            fnreg = this._irBuilder.allocRegister();
            this._irBuilder.add(new JSIr.GetScope(op.name, fnreg));
        }

        const args = this._compileVarRefInputParams(decl, op.in_params);
        const iterator = this._irBuilder.allocRegister();
        // all of stream, query and action invoke as stream, because of the lazy evaluation of query
        this._irBuilder.add(new JSIr.InvokeStreamVarRef(fnreg, iterator, args));

        const result = this._irBuilder.allocRegister();
        const loop = new JSIr.AsyncWhileLoop(result, iterator);
        this._irBuilder.add(loop);
        this._irBuilder.pushBlock(loop.body);
        this._setInvocationOutputs(decl.schema, {}, result);
    }

    private _compileInvokeTableVarRef(tableop : Ops.InvokeVarRefTableOp) {
        const decl = this._currentScope.get(tableop.name);
        assert(decl.type !== 'scalar');
        assert(decl.type !== 'procedure');

        if (decl.type === 'declaration') {
            const tryCatch = new JSIr.TryCatch("Failed to invoke query");
            this._irBuilder.add(tryCatch);
            this._irBuilder.pushBlock(tryCatch.try);

            this._compileInvokeGenericVarRef(tableop);
        } else {
            // assignment

            let list;
            if (decl.isPersistent) {
                list = this._irBuilder.allocRegister();
                const state = decl.register;
                assert(state !== null);
                this._irBuilder.add(new JSIr.InvokeReadState(list, state));
            } else {
                list = decl.register;
            }
            assert(list !== null);

            const result = this._compileIterateQuery(list);
            this._setInvocationOutputs(decl.schema, {}, result);
        }
    }

    private _compileInvokeStreamVarRef(streamop : Ops.InvokeVarRefStreamOp) {
        const tryCatch = new JSIr.TryCatch("Failed to invoke stream");
        this._irBuilder.add(tryCatch);
        this._irBuilder.pushBlock(tryCatch.try);

        this._compileInvokeGenericVarRef(streamop);
    }

    private _compileInvokeOutput() {
        if (this._forProcedure)
            this._irBuilder.add(new JSIr.InvokeEmit(getRegister('$outputType', this._currentScope), getRegister('$output', this._currentScope)));
        else
            this._irBuilder.add(new JSIr.InvokeOutput(getRegister('$outputType', this._currentScope), getRegister('$output', this._currentScope)));
    }

    private _compileInvokeAction(action : Ast.InvocationAction|Ast.InvocationTable) {
        const [kind, attrs, fname] = this._compileTpFunctionCall(action.invocation);
        const [argmap, args] = this._compileInputParams(action.invocation);

        // for compatibility with existing actions that return nothing or random stuff (usually
        // an HTTP response), we ignore the return value of actions that are declared without
        // output parameters
        if (action.schema!.hasAnyOutputArg()) {
            const list = this._irBuilder.allocRegister();
            this._irBuilder.add(new JSIr.InvokeAction(kind, attrs, fname, list, args));

            const result = this._compileIterateQuery(list);
            this._setInvocationOutputs(action.schema!, argmap, result);

            return true;
        } else {
            this._irBuilder.add(new JSIr.InvokeVoidAction(kind, attrs, fname, args));
            return false;
        }
    }

    private _compileAction(ast : Ast.Action) {
        const tryCatch = new JSIr.TryCatch("Failed to invoke action");
        this._irBuilder.add(tryCatch);
        this._irBuilder.pushBlock(tryCatch.try);

        if (ast instanceof Ast.NotifyAction) {
            this._compileInvokeOutput();
        } else {
            const stack = this._irBuilder.saveStackState();

            let hasResult;
            if (ast instanceof Ast.VarRefAction) {
                this._compileInvokeGenericVarRef(ast);
                hasResult = true;
            } else {
                assert(ast instanceof Ast.InvocationAction);
                hasResult = this._compileInvokeAction(ast);
            }

            if (hasResult && !this._forProcedure)
                this._compileInvokeOutput();

            // pop the blocks introduced by iterating the query
            this._irBuilder.popTo(stack);
        }

        this._irBuilder.popBlock();
    }

    private _compileStreamFilter(streamop : Ops.FilterStreamOp) {
        this._compileStream(streamop.stream);

        const filter = this._compileFilter(streamop.filter, this._currentScope);

        const ifStmt = new JSIr.IfStatement(filter);
        this._irBuilder.add(ifStmt);
        this._irBuilder.pushBlock(ifStmt.iftrue);
    }

    private _compileTableFilter(tableop : Ops.FilterTableOp) {
        this._compileTable(tableop.table);

        const filter = this._compileFilter(tableop.filter, this._currentScope);

        const ifStmt = new JSIr.IfStatement(filter);
        this._irBuilder.add(ifStmt);
        this._irBuilder.pushBlock(ifStmt.iftrue);
    }

    private _compileProjection(proj : Ops.ProjectionPointWiseOp) {
        const newScope = new Scope(this._globalScope);

        const newOutput = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.CreateObject(newOutput));

        // we need to create new objects for arguments of compound type
        // track them as we create them
        const newCompounds = new Set;

        // copy-over input parameters
        for (const [name, value] of this._currentScope) {
            if (value.type !== 'scalar' || value.direction !== 'input')
                continue;
            this._irBuilder.add(new JSIr.SetKey(newOutput, name, value.register));
        }

        for (const name of proj.args) {
            if (name.indexOf('.') >= 0) {
                const parts = name.split('.');
                // for all parts except the last one, create an object if needed
                for (let i = 0; i < parts.length-1; i++) {
                    const partKey = parts.slice(0, i+1).join('.');
                    if (newCompounds.has(partKey))
                        continue;
                    newCompounds.add(partKey);
                    const newObject = this._irBuilder.allocRegister();
                    this._irBuilder.add(new JSIr.CreateObject(newObject));
                    this._irBuilder.add(new JSIr.SetKey(newOutput, partKey, newObject));
                }
            }

            const value = this._currentScope.get(name);
            assert(value.type === 'scalar');
            this._irBuilder.add(new JSIr.SetKey(newOutput, name, value.register));
            newScope.set(name, value);
        }

        newScope.set('$outputType', this._currentScope.get('$outputType'));
        newScope.set('$output', {
            type: 'scalar',
            tt_type: null,
            register: newOutput,
            direction: 'special',
            isInVarScopeNames: false
        });

        this._currentScope = newScope;
        this._varScopeNames = Array.from(proj.args);
    }

    private _compileCompute(compute : Ops.ComputePointWiseOp) {
        const computeresult = this.compileValue(compute.expression, this._currentScope);
        const type = compute.expression.getType();

        this._irBuilder.add(new JSIr.SetKey(getRegister('$output', this._currentScope),
            compute.alias, computeresult));

        this._currentScope.set(compute.alias, {
            type: 'scalar',
            register: computeresult,
            tt_type: type,
            direction: 'output',
            isInVarScopeNames: false
        });
    }

    private _compileStreamMap(streamop : Ops.MapStreamOp) {
        this._compileStream(streamop.stream);

        if (streamop.op instanceof Ops.ProjectionPointWiseOp)
            this._compileProjection(streamop.op);
        else if (streamop.op instanceof Ops.ComputePointWiseOp)
            this._compileCompute(streamop.op);
        else
            throw new TypeError();
    }

    private _compileTableMap(tableop : Ops.MapTableOp) {
        this._compileTable(tableop.table);

        if (tableop.op instanceof Ops.ProjectionPointWiseOp)
            this._compileProjection(tableop.op);
        else if (tableop.op instanceof Ops.ComputePointWiseOp)
            this._compileCompute(tableop.op);
        else
            throw new TypeError();
    }

    private _compileTableReduce(tableop : Ops.ReduceTableOp) {
        const state = tableop.op.init(this._irBuilder, this._currentScope, this);

        const here = this._irBuilder.saveStackState();

        this._compileTable(tableop.table);
        tableop.op.advance(state, this._irBuilder, this._currentScope, this._varScopeNames);

        this._irBuilder.popTo(here);

        [this._currentScope, this._varScopeNames] =
            tableop.op.finish(state, this._irBuilder, this._currentScope, this._varScopeNames);
    }

    private _compileStreamEdgeNew(streamop : Ops.EdgeNewStreamOp) {
        const state = this._irBuilder.allocRegister();
        const stateId = this._allocState();

        this._irBuilder.add(new JSIr.InvokeReadState(state, stateId));

        this._compileStream(streamop.stream);

        const isNewTuple = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.CheckIsNewTuple(isNewTuple, state, getRegister('$output', this._currentScope),
                            this._varScopeNames));

        const newState = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.AddTupleToState(newState, state, getRegister('$output', this._currentScope)));

        this._irBuilder.add(new JSIr.InvokeWriteState(newState, stateId));
        this._irBuilder.add(new JSIr.Copy(newState, state));

        const ifStmt = new JSIr.IfStatement(isNewTuple);
        this._irBuilder.add(ifStmt);
        this._irBuilder.pushBlock(ifStmt.iftrue);
    }

    private _compileStreamEdgeFilter(streamop : Ops.EdgeFilterStreamOp) {
        const stateId = this._allocState();

        this._compileStream(streamop.stream);

        const state = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.InvokeReadState(state, stateId));

        const filter = this._compileFilter(streamop.filter, this._currentScope);

        // only write the new state if different from the old one (to avoid
        // repeated writes)
        const different = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.BinaryOp(filter, state, '!==', different));
        const ifDifferent = new JSIr.IfStatement(different);
        this._irBuilder.add(ifDifferent);
        this._irBuilder.pushBlock(ifDifferent.iftrue);
        this._irBuilder.add(new JSIr.InvokeWriteState(filter, stateId));
        this._irBuilder.popBlock();

        // negate the state, then and it to the filter to compute whether the rule
        // should fire or not
        this._irBuilder.add(new JSIr.UnaryOp(state, '!', state));
        this._irBuilder.add(new JSIr.BinaryOp(filter, state, '&&', filter));

        const ifStmt = new JSIr.IfStatement(filter);
        this._irBuilder.add(ifStmt);
        this._irBuilder.pushBlock(ifStmt.iftrue);
    }

    private _readTypeResult(typeAndResult : JSIr.Register) : [JSIr.Register, JSIr.Register] {
        const outputType = this._irBuilder.allocRegister();
        const result = this._irBuilder.allocRegister();

        this._irBuilder.add(new JSIr.GetIndex(typeAndResult, 0, outputType));
        this._irBuilder.add(new JSIr.GetIndex(typeAndResult, 1, result));

        return [outputType, result];
    }

    private _mergeResults(lhsScope : Scope, rhsScope : Scope) : [JSIr.Register, JSIr.Register] {
        const lhsOutputType = getRegister('$outputType', lhsScope);
        const rhsOutputType = getRegister('$outputType', rhsScope);

        const newOutputType = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.BinaryFunctionOp(lhsOutputType, rhsOutputType, 'combineOutputTypes', newOutputType));

        const newResult = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.CreateObject(newResult));

        for (const outParam of rhsScope.ownKeys()) {
            if (outParam.startsWith('$'))
                continue;
            this._irBuilder.add(new JSIr.SetKey(newResult, outParam, getRegister(outParam, rhsScope)));
        }
        for (const outParam of lhsScope.ownKeys()) {
            if (outParam.startsWith('$') || rhsScope.hasOwnKey(outParam))
                continue;
            this._irBuilder.add(new JSIr.SetKey(newResult, outParam, getRegister(outParam, lhsScope)));
        }

        return [newOutputType, newResult];
    }

    private _mergeScopes(lhsScope : Scope, rhsScope : Scope,
                         outputType : JSIr.Register, result : JSIr.Register) {
        this._currentScope = new Scope(this._globalScope);
        this._currentScope.set('$outputType', {
            type: 'scalar',
            tt_type: null,
            register: outputType,
            direction: 'special',
            isInVarScopeNames: false
        });
        this._currentScope.set('$output', {
            type: 'scalar',
            tt_type: null,
            register: result,
            direction: 'special',
            isInVarScopeNames: false
        });
        this._varScopeNames = [];

        for (const outParam of rhsScope.ownKeys()) {
            if (outParam.startsWith('$'))
                continue;
            const reg = this._irBuilder.allocRegister();
            this._irBuilder.add(new JSIr.GetKey(result, outParam, reg));

            const currentScopeObj = rhsScope.get(outParam);
            assert(currentScopeObj.type === 'scalar');
            this._currentScope.set(outParam, {
                type: 'scalar',
                tt_type: currentScopeObj.tt_type,
                direction: currentScopeObj.direction,
                register: reg,
                isInVarScopeNames: currentScopeObj.isInVarScopeNames
            });
            if (currentScopeObj.isInVarScopeNames)
                this._varScopeNames.push(outParam);
        }
        for (const outParam of lhsScope.ownKeys()) {
            if (outParam.startsWith('$'))
                continue;
            if (rhsScope.hasOwnKey(outParam))
                continue;
            const reg = this._irBuilder.allocRegister();
            this._irBuilder.add(new JSIr.GetKey(result, outParam, reg));
            const currentScopeObj = lhsScope.get(outParam);
            assert(currentScopeObj.type === 'scalar');
            this._currentScope.set(outParam, {
                type: 'scalar',
                tt_type: currentScopeObj.tt_type,
                direction: currentScopeObj.direction,
                register: reg,
                isInVarScopeNames: currentScopeObj.isInVarScopeNames
            });
            if (currentScopeObj.isInVarScopeNames)
                this._varScopeNames.push(outParam);
        }
    }

    private _compileStreamUnion(streamop : Ops.UnionStreamOp) {
        // compile the two streams to two generator expressions, and then pass
        // them to a builtin which will do the right thing

        const lhs = this._irBuilder.allocRegister();
        const lhsbody = new JSIr.AsyncFunctionExpression(lhs);
        this._irBuilder.add(lhsbody);
        let upto = this._irBuilder.pushBlock(lhsbody.body);

        this._compileStream(streamop.lhs);
        this._irBuilder.add(new JSIr.InvokeEmit(getRegister('$outputType', this._currentScope), getRegister('$output', this._currentScope)));

        const lhsScope = this._currentScope;
        this._irBuilder.popTo(upto);

        const rhs = this._irBuilder.allocRegister();
        const rhsbody = new JSIr.AsyncFunctionExpression(rhs);

        this._irBuilder.add(rhsbody);
        upto = this._irBuilder.pushBlock(rhsbody.body);

        this._compileStream(streamop.rhs);
        this._irBuilder.add(new JSIr.InvokeEmit(getRegister('$outputType', this._currentScope), getRegister('$output', this._currentScope)));

        const rhsScope = this._currentScope;
        this._irBuilder.popTo(upto);

        const iterator = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.BinaryFunctionOp(lhs, rhs, 'streamUnion', iterator));

        const typeAndResult = this._irBuilder.allocRegister();
        const loop = new JSIr.AsyncWhileLoop(typeAndResult, iterator);
        this._irBuilder.add(loop);
        this._irBuilder.pushBlock(loop.body);

        const [outputType, result] = this._readTypeResult(typeAndResult);
        this._mergeScopes(lhsScope, rhsScope, outputType, result);
    }

    private _compileStreamJoin(streamop : Ops.JoinStreamOp) {
        if (streamop.stream === Ops.StreamOp.Now) {
            this._compileTable(streamop.table);
            return;
        }

        this._compileStream(streamop.stream);

        const streamScope = this._currentScope;

        this._compileTable(streamop.table);

        const tableScope = this._currentScope;

        const [outputType, result] = this._mergeResults(streamScope, tableScope);
        this._mergeScopes(streamScope, tableScope, outputType, result);
    }

    private _compileStreamInvokeTable(streamop : Ops.InvokeTableStreamOp) {
        const state = this._irBuilder.allocRegister();
        const stateId = this._allocState();

        this._irBuilder.add(new JSIr.InvokeReadState(state, stateId));

        this._compileStream(streamop.stream);

        const timestamp = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.GetKey(getRegister('$output', this._currentScope), '__timestamp', timestamp));

        const isOldTimestamp = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.BinaryOp(timestamp, state, '<=', isOldTimestamp));

        const isNewTimestamp = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.UnaryOp(isOldTimestamp, '!', isNewTimestamp));

        const ifStmt = new JSIr.IfStatement(isNewTimestamp);
        this._irBuilder.add(ifStmt);
        this._irBuilder.pushBlock(ifStmt.iftrue);

        this._irBuilder.add(new JSIr.InvokeWriteState(timestamp, stateId));
        this._irBuilder.add(new JSIr.Copy(timestamp, state));

        // compileTable will discard the currentScope here
        this._compileTable(streamop.table);
    }

    private _compileStream(streamop : Ops.StreamOp) {
        if (streamop === Ops.StreamOp.Now)
            return;

        if (streamop instanceof Ops.InvokeVarRefStreamOp)
            this._compileInvokeStreamVarRef(streamop);
        else if (streamop instanceof Ops.InvokeSubscribeStreamOp)
            this._compileInvokeSubscribe(streamop);
        else if (streamop instanceof Ops.InvokeTableStreamOp)
            this._compileStreamInvokeTable(streamop);
        else if (streamop instanceof Ops.TimerStreamOp)
            this._compileTimer(streamop);
        else if (streamop instanceof Ops.AtTimerStreamOp)
            this._compileAtTimer(streamop);
        else if (streamop instanceof Ops.FilterStreamOp)
            this._compileStreamFilter(streamop);
        else if (streamop instanceof Ops.MapStreamOp)
            this._compileStreamMap(streamop);
        else if (streamop instanceof Ops.EdgeNewStreamOp)
            this._compileStreamEdgeNew(streamop);
        else if (streamop instanceof Ops.EdgeFilterStreamOp)
            this._compileStreamEdgeFilter(streamop);
        else if (streamop instanceof Ops.UnionStreamOp)
            this._compileStreamUnion(streamop);
        else if (streamop instanceof Ops.JoinStreamOp)
            this._compileStreamJoin(streamop);
        else
            throw new TypeError();
    }

    private _compileTableCrossJoin(tableop : Ops.CrossJoinTableOp) {
        // compile the two tables to two generator expressions, and then pass
        // them to a builtin which will compute the cross join

        const lhs = this._irBuilder.allocRegister();
        const lhsbody = new JSIr.AsyncFunctionExpression(lhs);
        this._irBuilder.add(lhsbody);
        let upto = this._irBuilder.pushBlock(lhsbody.body);

        this._compileTable(tableop.lhs);
        this._irBuilder.add(new JSIr.InvokeEmit(getRegister('$outputType', this._currentScope), getRegister('$output', this._currentScope)));

        const lhsScope = this._currentScope;
        this._irBuilder.popTo(upto);

        const rhs = this._irBuilder.allocRegister();
        const rhsbody = new JSIr.AsyncFunctionExpression(rhs);

        this._irBuilder.add(rhsbody);
        upto = this._irBuilder.pushBlock(rhsbody.body);

        this._compileTable(tableop.rhs);
        this._irBuilder.add(new JSIr.InvokeEmit(getRegister('$outputType', this._currentScope), getRegister('$output', this._currentScope)));

        const rhsScope = this._currentScope;
        this._irBuilder.popTo(upto);

        const iterator = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.BinaryFunctionOp(lhs, rhs, 'tableCrossJoin', iterator));

        const typeAndResult = this._irBuilder.allocRegister();
        const loop = new JSIr.AsyncWhileLoop(typeAndResult, iterator);
        this._irBuilder.add(loop);
        this._irBuilder.pushBlock(loop.body);

        const [outputType, result] = this._readTypeResult(typeAndResult);
        this._mergeScopes(lhsScope, rhsScope, outputType, result);
    }

    private _compileTableNestedLoopJoin(tableop : Ops.NestedLoopJoinTableOp) {
        this._compileTable(tableop.lhs);

        const lhsScope = this._currentScope;

        this._compileTable(tableop.rhs);

        const rhsScope = this._currentScope;

        const [outputType, result] = this._mergeResults(lhsScope, rhsScope);
        this._mergeScopes(lhsScope, rhsScope, outputType, result);
    }

    private _compileDatabaseQuery(tableop : Ops.TableOp) {
        const tryCatch = new JSIr.TryCatch("Failed to invoke query");
        this._irBuilder.add(tryCatch);
        this._irBuilder.pushBlock(tryCatch.try);

        assert(tableop.device);
        const kind = tableop.device.kind;
        const attrs = tableop.device.id ? { id: tableop.device.id } : {};
        const list = this._irBuilder.allocRegister();
        const query = new Ast.Input.Program(
            null /* location */,
            [],
            [],
            [new Ast.ExpressionStatement(null, tableop.ast.toExpression([]))]
        );
        const astId = this._compiler._allocAst(query);
        const astReg = this._irBuilder.allocRegister();

        this._irBuilder.add(new JSIr.GetASTObject(astId, astReg));
        this._irBuilder.add(new JSIr.InvokeDBQuery(kind, attrs, list, astReg));

        const result = this._compileIterateQuery(list);
        this._setInvocationOutputs(tableop.ast.schema!, {}, result);
    }

    private _compileTable(tableop : Ops.TableOp) {
        if (tableop.handle_thingtalk)
            this._compileDatabaseQuery(tableop);
        else if (tableop instanceof Ops.InvokeVarRefTableOp)
            this._compileInvokeTableVarRef(tableop);
        else if (tableop instanceof Ops.InvokeGetTableOp)
            this._compileInvokeGet(tableop);
        else if (tableop instanceof Ops.FilterTableOp)
            this._compileTableFilter(tableop);
        else if (tableop instanceof Ops.MapTableOp)
            this._compileTableMap(tableop);
        else if (tableop instanceof Ops.ReduceTableOp)
            this._compileTableReduce(tableop);
        else if (tableop instanceof Ops.CrossJoinTableOp)
            this._compileTableCrossJoin(tableop);
        else if (tableop instanceof Ops.NestedLoopJoinTableOp)
            this._compileTableNestedLoopJoin(tableop);
        else
            throw new TypeError();
    }

    private _compileEndOfFlow(action : Ast.Action) {
        if (!(action instanceof Ast.InvocationAction) ||
            !isRemoteSend(action.invocation))
            return;

        const tryCatch = new JSIr.TryCatch("Failed to signal end-of-flow");

        this._irBuilder.add(tryCatch);
        this._irBuilder.pushBlock(tryCatch.try);

        let principal, flow;
        for (const inParam of action.invocation.in_params) {
            if (inParam.name !== '__principal' && inParam.name !== '__flow')
                continue;
            const reg = this.compileValue(inParam.value, this._currentScope);
            if (inParam.name === '__flow')
                flow = reg;
            else
                principal = reg;
        }
        assert(principal !== undefined);
        assert(flow !== undefined);
        this._irBuilder.add(new JSIr.SendEndOfFlow(principal, flow));

        this._irBuilder.popBlock();
    }

    compileStatement(ruleop : Ops.RuleOp) : void {
        this._compileStream(ruleop.stream);
        for (const action of ruleop.actions)
            this._compileAction(action);

        this._irBuilder.popAll();

        for (const action of ruleop.actions)
            this._compileEndOfFlow(action);
    }

    compileStreamDeclaration(streamop : Ops.StreamOp) : void {
        this._compileStream(streamop);
        this._irBuilder.add(new JSIr.InvokeEmit(getRegister('$outputType', this._currentScope), getRegister('$output', this._currentScope)));

        this._irBuilder.popAll();
    }

    compileQueryDeclaration(tableop : Ops.TableOp) : void {
        this._compileTable(tableop);
        this._irBuilder.add(new JSIr.InvokeEmit(getRegister('$outputType', this._currentScope), getRegister('$output', this._currentScope)));

        this._irBuilder.popAll();
    }

    compileActionDeclaration(action : Ast.Action) : void {
        this._compileAction(action);
        this._irBuilder.popAll();
    }

    compileActionAssignment(action : Ast.InvocationAction|Ast.VarRefAction,
                            isPersistent : boolean) : JSIr.Register {
        const register = this._irBuilder.allocRegister();
        let stateId;
        this._irBuilder.add(new JSIr.CreateTuple(0, register));

        let hasResult;
        if (action instanceof Ast.VarRefAction) {
            this._compileInvokeGenericVarRef(action);
            hasResult = true;
        } else {
            hasResult = this._compileInvokeAction(action);
        }

        // an action assignment without a result does not make much sense, but it typechecks,
        // so we allow it, and interpret it to be an empty array
        if (hasResult) {
            const resultAndTypeTuple = this._irBuilder.allocRegister();
            this._irBuilder.add(new JSIr.CreateTuple(2, resultAndTypeTuple));
            this._irBuilder.add(new JSIr.SetIndex(resultAndTypeTuple, 0, getRegister('$outputType', this._currentScope)));
            this._irBuilder.add(new JSIr.SetIndex(resultAndTypeTuple, 1, getRegister('$output', this._currentScope)));

            this._irBuilder.add(new JSIr.UnaryMethodOp(register, resultAndTypeTuple, 'push'));
        }

        this._irBuilder.popAll();

        if (isPersistent) {
            stateId = this._allocState();
            this._irBuilder.add(new JSIr.InvokeWriteState(register, stateId));
            return stateId;
        } else {
            return register;
        }
    }

    compileAssignment(tableop : Ops.TableOp, isPersistent : boolean) : JSIr.Register {
        const register = this._irBuilder.allocRegister();
        let stateId;
        this._irBuilder.add(new JSIr.CreateTuple(0, register));

        this._compileTable(tableop);
        const resultAndTypeTuple = this._irBuilder.allocRegister();
        this._irBuilder.add(new JSIr.CreateTuple(2, resultAndTypeTuple));
        this._irBuilder.add(new JSIr.SetIndex(resultAndTypeTuple, 0, getRegister('$outputType', this._currentScope)));
        this._irBuilder.add(new JSIr.SetIndex(resultAndTypeTuple, 1, getRegister('$output', this._currentScope)));

        this._irBuilder.add(new JSIr.UnaryMethodOp(register, resultAndTypeTuple, 'push'));

        this._irBuilder.popAll();

        if (isPersistent) {
            stateId = this._allocState();
            this._irBuilder.add(new JSIr.InvokeWriteState(register, stateId));
            return stateId;
        } else {
            return register;
        }
    }
}
