/********************************************************************************
 * Copyright (c) 2017-2022 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject, optional } from "inversify";
import { Action, UpdateModelAction as ProtocolUpdateModelAction } from "sprotty-protocol/lib/actions";
import { SModelRoot as SModelRootSchema } from 'sprotty-protocol/lib/model';
import { almostEquals, Dimension } from "sprotty-protocol/lib/utils/geometry";
import { Animation, CompoundAnimation } from '../../base/animations/animation';
import { CommandExecutionContext, CommandReturn, Command } from '../../base/commands/command';
import { FadeAnimation, ResolvedElementFade } from '../fade/fade';
import { SModelRootImpl, SChildElementImpl, SModelElementImpl, SParentElementImpl } from "../../base/model/smodel";
import { MoveAnimation, ResolvedElementMove, MorphEdgesAnimation } from "../move/move";
import { Fadeable, isFadeable } from "../fade/model";
import { isLocateable } from "../move/model";
import { isSizeable } from "../bounds/model";
import { ViewportRootElement } from "../viewport/viewport-root";
import { isSelectable } from "../select/model";
import { MatchResult, ModelMatcher, Match, forEachMatch } from "./model-matching";
import { ResolvedElementResize, ResizeAnimation } from '../bounds/resize';
import { TYPES } from "../../base/types";
import { isViewport } from "../viewport/model";
import { EdgeRouterRegistry, EdgeSnapshot, EdgeMemento } from "../routing/routing";
import { SRoutableElementImpl } from "../routing/model";
import { containsSome } from "../../base/model/smodel-utils";

/**
 * Sent from the model source to the client in order to update the model. If no model is present yet,
 * this behaves the same as a SetModelAction. The transition from the old model to the new one can be animated.
 *
 * @deprecated Use the declaration from `sprotty-protocol` instead.
 */
export class UpdateModelAction implements Action, ProtocolUpdateModelAction {
    static readonly KIND = 'updateModel';
    readonly kind = UpdateModelAction.KIND;

    public readonly newRoot?: SModelRootSchema;
    public readonly matches?: Match[];

    constructor(input: SModelRootSchema | Match[],
        public readonly animate: boolean = true,
        public readonly cause?: Action) {
        if ((input as SModelRootSchema).id !== undefined)
            this.newRoot = input as SModelRootSchema;
        else
            this.matches = input as Match[];
    }
}

export interface UpdateAnimationData {
    fades: ResolvedElementFade[]
    moves?: ResolvedElementMove[]
    resizes?: ResolvedElementResize[]
    edgeMementi?: EdgeMemento[]
}

@injectable()
export class UpdateModelCommand extends Command {
    static readonly KIND = ProtocolUpdateModelAction.KIND;

    oldRoot: SModelRootImpl;
    newRoot: SModelRootImpl;

    @inject(EdgeRouterRegistry) @optional() edgeRouterRegistry?: EdgeRouterRegistry;

    constructor(@inject(TYPES.Action) protected readonly action: ProtocolUpdateModelAction) {
        super();
    }

    execute(context: CommandExecutionContext): CommandReturn {
        let newRoot: SModelRootImpl;
        if (this.action.newRoot !== undefined) {
            newRoot = context.modelFactory.createRoot(this.action.newRoot);
        } else {
            newRoot = context.modelFactory.createRoot(context.root);
            if (this.action.matches !== undefined)
                this.applyMatches(newRoot, this.action.matches, context);
        }
        this.oldRoot = context.root;
        this.newRoot = newRoot;
        return this.performUpdate(this.oldRoot, this.newRoot, context);
    }

    protected performUpdate(oldRoot: SModelRootImpl, newRoot: SModelRootImpl, context: CommandExecutionContext): CommandReturn {
        if ((this.action.animate === undefined || this.action.animate) && oldRoot.id === newRoot.id) {
            let matchResult: MatchResult;
            if (this.action.matches === undefined) {
                const matcher = new ModelMatcher();
                matchResult = matcher.match(oldRoot, newRoot);
            } else {
                matchResult = this.convertToMatchResult(this.action.matches, oldRoot, newRoot);
            }
            const animationOrRoot = this.computeAnimation(newRoot, matchResult, context);
            if (animationOrRoot instanceof Animation)
                return animationOrRoot.start();
            else
                return animationOrRoot;
        } else {
            if (oldRoot.type === newRoot.type && Dimension.isValid(oldRoot.canvasBounds))
                newRoot.canvasBounds = oldRoot.canvasBounds;
            if (isViewport(oldRoot) && isViewport(newRoot)) {
                newRoot.zoom = oldRoot.zoom;
                newRoot.scroll = oldRoot.scroll;
            }
            return newRoot;
        }
    }

    protected applyMatches(root: SModelRootImpl, matches: Match[], context: CommandExecutionContext): void {
        const index = root.index;
        for (const match of matches) {
            if (match.left !== undefined) {
                const element = index.getById(match.left.id);
                if (element instanceof SChildElementImpl)
                    element.parent.remove(element);
            }
        }
        for (const match of matches) {
            if (match.right !== undefined) {
                const element = context.modelFactory.createElement(match.right);
                let parent: SModelElementImpl | undefined;
                if (match.rightParentId !== undefined)
                    parent = index.getById(match.rightParentId);
                if (parent instanceof SParentElementImpl)
                    parent.add(element);
                else
                    root.add(element);
            }
        }
    }

    protected convertToMatchResult(matches: Match[], leftRoot: SModelRootImpl, rightRoot: SModelRootImpl): MatchResult {
        const result: MatchResult = {};
        for (const match of matches) {
            const converted: Match = {};
            let id: string | undefined = undefined;
            if (match.left !== undefined) {
                id = match.left.id;
                converted.left = leftRoot.index.getById(id);
                converted.leftParentId = match.leftParentId;
            }
            if (match.right !== undefined) {
                id = match.right.id;
                converted.right = rightRoot.index.getById(id);
                converted.rightParentId = match.rightParentId;
            }
            if (id !== undefined)
                result[id] = converted;
        }
        return result;
    }

    protected computeAnimation(newRoot: SModelRootImpl, matchResult: MatchResult, context: CommandExecutionContext): SModelRootImpl | Animation {
        const animationData: UpdateAnimationData = {
            fades: [] as ResolvedElementFade[]
        };
        forEachMatch(matchResult, (id, match) => {
            if (match.left !== undefined && match.right !== undefined) {
                // The element is still there, but may have been moved
                this.updateElement(match.left as SModelElementImpl, match.right as SModelElementImpl, animationData);
            } else if (match.right !== undefined) {
                // An element has been added
                const right = match.right as SModelElementImpl;
                if (isFadeable(right)) {
                    right.opacity = 0;
                    animationData.fades.push({
                        element: right,
                        type: 'in'
                    });
                }
            } else if (match.left instanceof SChildElementImpl) {
                // An element has been removed
                const left = match.left;
                if (isFadeable(left) && match.leftParentId !== undefined) {
                    if (!containsSome(newRoot, left)) {
                        const parent = newRoot.index.getById(match.leftParentId);
                        if (parent instanceof SParentElementImpl) {
                            const leftCopy = context.modelFactory.createElement(left) as SChildElementImpl & Fadeable;
                            parent.add(leftCopy);
                            animationData.fades.push({
                                element: leftCopy,
                                type: 'out'
                            });
                        }
                    }
                }
            }
        });

        const animations = this.createAnimations(animationData, newRoot, context);
        if (animations.length >= 2) {
            return new CompoundAnimation(newRoot, context, animations);
        } else if (animations.length === 1) {
            return animations[0];
        } else {
            return newRoot;
        }
    }

    protected updateElement(left: SModelElementImpl, right: SModelElementImpl, animationData: UpdateAnimationData): void {
        if (isLocateable(left) && isLocateable(right)) {
            const leftPos = left.position;
            const rightPos = right.position;
            if (!almostEquals(leftPos.x, rightPos.x) || !almostEquals(leftPos.y, rightPos.y)) {
                if (animationData.moves === undefined)
                    animationData.moves = [];
                animationData.moves.push({
                    element: right,
                    fromPosition: leftPos,
                    toPosition: rightPos
                });
                right.position = leftPos;
            }
        }
        if (isSizeable(left) && isSizeable(right)) {
            if (!Dimension.isValid(right.bounds)) {
                right.bounds = {
                    x: right.bounds.x,
                    y: right.bounds.y,
                    width: left.bounds.width,
                    height: left.bounds.height
                };
            } else if (!almostEquals(left.bounds.width, right.bounds.width)
                || !almostEquals(left.bounds.height, right.bounds.height)) {
                if (animationData.resizes === undefined)
                    animationData.resizes = [];
                animationData.resizes.push({
                    element: right,
                    fromDimension: {
                        width: left.bounds.width,
                        height: left.bounds.height,
                    },
                    toDimension: {
                        width: right.bounds.width,
                        height: right.bounds.height,
                    }
                });
            }
        }
        if (left instanceof SRoutableElementImpl && right instanceof SRoutableElementImpl && this.edgeRouterRegistry) {
            if (animationData.edgeMementi === undefined)
                animationData.edgeMementi = [];
            animationData.edgeMementi.push({
                edge: right,
                before: this.takeSnapshot(left),
                after: this.takeSnapshot(right),
            });
        }
        if (isSelectable(left) && isSelectable(right)) {
            right.selected = left.selected;
        }
        if (left instanceof SModelRootImpl && right instanceof SModelRootImpl) {
            right.canvasBounds = left.canvasBounds;
        }
        if (left instanceof ViewportRootElement && right instanceof ViewportRootElement) {
            right.scroll = left.scroll;
            right.zoom = left.zoom;
        }
    }

    protected takeSnapshot(edge: SRoutableElementImpl): EdgeSnapshot {
        const router = this.edgeRouterRegistry!.get(edge.routerKind);
        return router.takeSnapshot(edge);
    }

    protected createAnimations(data: UpdateAnimationData, root: SModelRootImpl, context: CommandExecutionContext): Animation[] {
        const animations: Animation[] = [];
        if (data.fades.length > 0) {
            animations.push(new FadeAnimation(root, data.fades, context, true));
        }
        if (data.moves !== undefined && data.moves.length > 0) {
            const movesMap: Map<string, ResolvedElementMove> = new Map;
            for (const move of data.moves) {
                movesMap.set(move.element.id, move);
            }
            animations.push(new MoveAnimation(root, movesMap, context, false));
        }
        if (data.resizes !== undefined && data.resizes.length > 0) {
            const resizesMap: Map<string, ResolvedElementResize> = new Map;
            for (const resize of data.resizes) {
                resizesMap.set(resize.element.id, resize);
            }
            animations.push(new ResizeAnimation(root, resizesMap, context, false));
        }
        if (data.edgeMementi !== undefined && data.edgeMementi.length > 0) {
            animations.push(new MorphEdgesAnimation(root, data.edgeMementi, context, false));
        }
        return animations;
    }

    undo(context: CommandExecutionContext): CommandReturn {
        return this.performUpdate(this.newRoot, this.oldRoot, context);
    }

    redo(context: CommandExecutionContext): CommandReturn {
        return this.performUpdate(this.oldRoot, this.newRoot, context);
    }
}

