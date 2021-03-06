/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import * as UUID from 'vs/base/common/uuid';
import * as editorCommon from 'vs/editor/common/editorCommon';
import * as model from 'vs/editor/common/model';
import { PrefixSumComputer } from 'vs/editor/common/viewModel/prefixSumComputer';
import { BOTTOM_CELL_TOOLBAR_HEIGHT, CELL_MARGIN, CELL_RUN_GUTTER, CELL_STATUSBAR_HEIGHT, EDITOR_BOTTOM_PADDING, EDITOR_TOOLBAR_HEIGHT, EDITOR_TOP_MARGIN, EDITOR_TOP_PADDING, CELL_BOTTOM_MARGIN, CODE_CELL_LEFT_MARGIN, BOTTOM_CELL_TOOLBAR_OFFSET } from 'vs/workbench/contrib/notebook/browser/constants';
import { CellEditState, CellFindMatch, CodeCellLayoutChangeEvent, CodeCellLayoutInfo, ICellViewModel, NotebookLayoutInfo, CodeCellLayoutState } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { NotebookCellTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookCellTextModel';
import { CellKind, NotebookCellOutputsSplice, INotebookSearchOptions } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { BaseCellViewModel } from './baseCellViewModel';
import { NotebookEventDispatcher } from 'vs/workbench/contrib/notebook/browser/viewModel/eventDispatcher';

export class CodeCellViewModel extends BaseCellViewModel implements ICellViewModel {
	readonly cellKind = CellKind.Code;
	protected readonly _onDidChangeOutputs = new Emitter<NotebookCellOutputsSplice[]>();
	readonly onDidChangeOutputs = this._onDidChangeOutputs.event;
	private _outputCollection: number[] = [];
	private _selfSizeMonitoring: boolean = false;
	set selfSizeMonitoring(newVal: boolean) {
		this._selfSizeMonitoring = newVal;
	}

	get selfSizeMonitoring() {
		return this._selfSizeMonitoring;
	}

	private _outputsTop: PrefixSumComputer | null = null;
	get outputs() {
		return this.model.outputs;
	}

	protected readonly _onDidChangeLayout = new Emitter<CodeCellLayoutChangeEvent>();
	readonly onDidChangeLayout = this._onDidChangeLayout.event;

	private _editorHeight = 0;
	set editorHeight(height: number) {
		this._editorHeight = height;

		this.layoutChange({ editorHeight: true });
	}

	get editorHeight() {
		throw new Error('editorHeight is write-only');
	}

	private _hoveringOutput: boolean = false;
	public get outputIsHovered(): boolean {
		return this._hoveringOutput;
	}

	public set outputIsHovered(v: boolean) {
		this._hoveringOutput = v;
		this._onDidChangeState.fire({ outputIsHoveredChanged: true });
	}

	private _layoutInfo: CodeCellLayoutInfo;

	get layoutInfo() {
		return this._layoutInfo;
	}

	constructor(
		readonly viewType: string,
		readonly model: NotebookCellTextModel,
		initialNotebookLayoutInfo: NotebookLayoutInfo | null,
		readonly eventDispatcher: NotebookEventDispatcher
	) {
		super(viewType, model, UUID.generateUuid());
		this._register(this.model.onDidChangeOutputs((splices) => {
			this._outputCollection = new Array(this.model.outputs.length);
			this._outputsTop = null;
			this._onDidChangeOutputs.fire(splices);
		}));

		this._outputCollection = new Array(this.model.outputs.length);

		this._layoutInfo = {
			fontInfo: initialNotebookLayoutInfo?.fontInfo || null,
			editorHeight: 0,
			editorWidth: initialNotebookLayoutInfo ? this.computeEditorWidth(initialNotebookLayoutInfo!.width) : 0,
			outputContainerOffset: 0,
			outputTotalHeight: 0,
			totalHeight: 0,
			indicatorHeight: 0,
			bottomToolbarOffset: 0,
			layoutState: CodeCellLayoutState.Uninitialized
		};
	}

	private computeEditorWidth(outerWidth: number): number {
		return outerWidth - (CODE_CELL_LEFT_MARGIN + (CELL_MARGIN * 2) + CELL_RUN_GUTTER);
	}

	layoutChange(state: CodeCellLayoutChangeEvent) {
		// recompute
		this._ensureOutputsTop();
		const outputTotalHeight = this._outputsTop!.getTotalValue();

		let newState: CodeCellLayoutState;
		let editorHeight: number;
		let totalHeight: number;
		if (!state.editorHeight && this._layoutInfo.layoutState === CodeCellLayoutState.FromCache) {
			// No new editorHeight info - keep cached totalHeight and estimate editorHeight
			editorHeight = this.estimateEditorHeight(state.font?.lineHeight);
			totalHeight = this._layoutInfo.totalHeight;
			newState = CodeCellLayoutState.FromCache;
		} else if (state.editorHeight || this._layoutInfo.layoutState === CodeCellLayoutState.Measured) {
			// Editor has been measured
			editorHeight = this._editorHeight;
			totalHeight = this.computeTotalHeight(this._editorHeight, outputTotalHeight);
			newState = CodeCellLayoutState.Measured;
		} else {
			editorHeight = this.estimateEditorHeight(state.font?.lineHeight);
			totalHeight = this.computeTotalHeight(editorHeight, outputTotalHeight);
			newState = CodeCellLayoutState.Estimated;
		}

		const indicatorHeight = editorHeight + CELL_STATUSBAR_HEIGHT + outputTotalHeight;
		const outputContainerOffset = EDITOR_TOOLBAR_HEIGHT + EDITOR_TOP_MARGIN + editorHeight + CELL_STATUSBAR_HEIGHT;
		const bottomToolbarOffset = totalHeight - BOTTOM_CELL_TOOLBAR_HEIGHT - BOTTOM_CELL_TOOLBAR_OFFSET;
		const editorWidth = state.outerWidth !== undefined ? this.computeEditorWidth(state.outerWidth) : this._layoutInfo?.editorWidth;

		this._layoutInfo = {
			fontInfo: state.font || null,
			editorHeight,
			editorWidth,
			outputContainerOffset,
			outputTotalHeight,
			totalHeight,
			indicatorHeight,
			bottomToolbarOffset,
			layoutState: newState
		};

		if (state.editorHeight || state.outputHeight) {
			state.totalHeight = true;
		}

		this._fireOnDidChangeLayout(state);
	}

	private _fireOnDidChangeLayout(state: CodeCellLayoutChangeEvent) {
		this._onDidChangeLayout.fire(state);
	}

	restoreEditorViewState(editorViewStates: editorCommon.ICodeEditorViewState | null, totalHeight?: number) {
		super.restoreEditorViewState(editorViewStates);
		if (totalHeight !== undefined && this._layoutInfo.layoutState !== CodeCellLayoutState.Measured) {
			this._layoutInfo = {
				fontInfo: this._layoutInfo.fontInfo,
				editorHeight: this._layoutInfo.editorHeight,
				editorWidth: this._layoutInfo.editorWidth,
				outputContainerOffset: this._layoutInfo.outputContainerOffset,
				outputTotalHeight: this._layoutInfo.outputTotalHeight,
				totalHeight: totalHeight,
				indicatorHeight: this._layoutInfo.indicatorHeight,
				bottomToolbarOffset: this._layoutInfo.bottomToolbarOffset,
				layoutState: CodeCellLayoutState.FromCache
			};
		}
	}

	hasDynamicHeight() {
		// CodeCellVM always measures itself and controls its cell's height
		return false;
	}

	firstLine(): string {
		return this.getText().split('\n')[0];
	}

	getHeight(lineHeight: number) {
		if (this._layoutInfo.layoutState === CodeCellLayoutState.Uninitialized) {
			const editorHeight = this.estimateEditorHeight(lineHeight);
			return this.computeTotalHeight(editorHeight, 0);
		} else {
			return this._layoutInfo.totalHeight;
		}
	}

	private estimateEditorHeight(lineHeight: number | undefined = 20): number {
		return this.lineCount * lineHeight + EDITOR_TOP_PADDING + EDITOR_BOTTOM_PADDING;
	}

	private computeTotalHeight(editorHeight: number, outputsTotalHeight: number): number {
		return EDITOR_TOOLBAR_HEIGHT + EDITOR_TOP_MARGIN + editorHeight + CELL_STATUSBAR_HEIGHT + outputsTotalHeight + BOTTOM_CELL_TOOLBAR_HEIGHT + CELL_BOTTOM_MARGIN;
	}

	/**
	 * Text model is used for editing.
	 */
	async resolveTextModel(): Promise<model.ITextModel> {
		if (!this.textModel) {
			const ref = await this.model.resolveTextModelRef();
			this.textModel = ref.object.textEditorModel;
			this._register(ref);
			this._register(this.textModel.onDidChangeContent(() => {
				this.editState = CellEditState.Editing;
				this._onDidChangeState.fire({ contentChanged: true });
			}));
		}

		return this.textModel;
	}

	onDeselect() {
		this.editState = CellEditState.Preview;
	}

	updateOutputHeight(index: number, height: number) {
		if (index >= this._outputCollection.length) {
			throw new Error('Output index out of range!');
		}

		this._outputCollection[index] = height;
		this._ensureOutputsTop();
		if (this._outputsTop!.changeValue(index, height)) {
			this.layoutChange({ outputHeight: true });
		}
	}

	getOutputOffsetInContainer(index: number) {
		this._ensureOutputsTop();

		if (index >= this._outputCollection.length) {
			throw new Error('Output index out of range!');
		}

		return this._outputsTop!.getAccumulatedValue(index - 1);
	}

	getOutputOffset(index: number): number {
		return this.layoutInfo.outputContainerOffset + this.getOutputOffsetInContainer(index);
	}

	spliceOutputHeights(start: number, deleteCnt: number, heights: number[]) {
		this._ensureOutputsTop();

		this._outputsTop!.removeValues(start, deleteCnt);
		if (heights.length) {
			const values = new Uint32Array(heights.length);
			for (let i = 0; i < heights.length; i++) {
				values[i] = heights[i];
			}

			this._outputsTop!.insertValues(start, values);
		}

		this.layoutChange({ outputHeight: true });
	}

	private _ensureOutputsTop(): void {
		if (!this._outputsTop) {
			const values = new Uint32Array(this._outputCollection.length);
			for (let i = 0; i < this._outputCollection.length; i++) {
				values[i] = this._outputCollection[i];
			}

			this._outputsTop = new PrefixSumComputer(values);
		}
	}

	private readonly _hasFindResult = this._register(new Emitter<boolean>());
	public readonly hasFindResult: Event<boolean> = this._hasFindResult.event;

	startFind(value: string, options: INotebookSearchOptions): CellFindMatch | null {
		const matches = super.cellStartFind(value, options);

		if (matches === null) {
			return null;
		}

		return {
			cell: this,
			matches
		};
	}

	dispose() {
		super.dispose();
	}
}
