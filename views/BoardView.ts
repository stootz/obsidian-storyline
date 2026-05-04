import { ItemView, WorkspaceLeaf, Menu, Notice, TFile, Modal, Setting, MarkdownRenderer } from 'obsidian';
import * as obsidian from 'obsidian';
import { Scene, SceneFilter, SortConfig, BoardGroupBy, SceneStatus, SceneTemplate, BUILTIN_BEAT_SHEETS, getStatusOrder, getStatusConfig, resolveStatusCfg } from '../models/Scene';
import { openConfirmModal } from '../components/ConfirmModal';
import { SceneManager } from '../services/SceneManager';
import { SceneCardComponent } from '../components/SceneCard';
import { FiltersComponent } from '../components/Filters';
import { InspectorComponent } from '../components/Inspector';
import { QuickAddModal } from '../components/QuickAddModal';
import { renderViewSwitcher } from '../components/ViewSwitcher';
import { VirtualScroller } from '../components/VirtualScroller';
import { enableDragToPan } from '../components/DragToPan';
import { SplitSceneModal, MergeSceneModal } from '../components/SplitMergeModals';
import { isMobile, applyMobileClass, enableTouchDrag } from '../components/MobileAdapter';
import { BOARD_VIEW_TYPE } from '../constants';
import { openManageSnapshotsModal } from '../components/ViewSnapshotModal';
import { resolveStickyNoteColors } from '../settings';
import { attachTooltip } from '../components/Tooltip';
import { resolveImagePath } from '../components/ImagePicker';
import type SceneCardsPlugin from '../main';
import { compareActChapter, parseActChapterInput, isPureNumericActChapter } from '../utils/actChapter';

type BoardMode = 'kanban' | 'corkboard';

/**
 * Board View - Kanban-style scene card board
 */
export class BoardView extends ItemView {
    private plugin: SceneCardsPlugin;
    private sceneManager: SceneManager;
    private cardComponent: SceneCardComponent;
    private filtersComponent: FiltersComponent | null = null;
    private inspectorComponent: InspectorComponent | null = null;
    private currentFilter: SceneFilter = {};
    private currentSort: SortConfig = { field: 'sequence', direction: 'asc' };
    private groupBy: BoardGroupBy = 'act';
    private selectedScene: Scene | null = null;
    private selectedScenes: Set<string> = new Set();
    private boardEl: HTMLElement | null = null;
    private bulkBarEl: HTMLElement | null = null;
    private rootContainer: HTMLElement | null = null;
    private _pendingRefresh: number | null = null;
    private _lastCacheVersion = -1;
    private boardMode: BoardMode = 'corkboard';
    private corkboardPositions: Map<string, { x: number; y: number; z: number; h?: number }> = new Map();
    private corkboardJustDragged: Set<string> = new Set();
    private corkboardPersistTimer: ReturnType<typeof setTimeout> | null = null;
    private corkboardLoadedProjectFile: string | null = null;
    private _corkboardProjectLoaded = false;
    private dragToPanCleanup: (() => void) | null = null;
    private corkboardInteractionCleanup: (() => void) | null = null;
    private corkboardCamera = { x: 220, y: 140, zoom: 1 };
    /** Inertia animation frame handle */
    private corkboardInertiaRaf: number | null = null;
    /** Smooth zoom animation frame handle */
    private corkboardZoomRaf: number | null = null;
    /** Accumulated target zoom for smooth chasing */
    private corkboardZoomTarget: number | null = null;
    /** Pivot point (viewport-local) for current zoom gesture */
    private corkboardZoomPivot = { vx: 0, vy: 0 };
    /** Toolbar zoom label element (corkboard only) */
    private corkboardZoomLabelEl: HTMLElement | null = null;
    /** Toolbar align controls wrapper for corkboard */
    private corkboardAlignControlsEl: HTMLElement | null = null;
    /** Toggle for temporary corkboard connection lines */
    private corkboardConnectionsEnabled: boolean = false;
    /** SVG overlay for temporary corkboard connections */
    private corkboardConnectionSvg: SVGSVGElement | null = null;
    /** Minimap canvas for corkboard (non-interactive) */
    private corkboardMinimapCanvas: HTMLCanvasElement | null = null;
    private quickNoteLastCreatedAt = 0;
    private quickNoteChainIndex = 0;
    /** Active virtual scrollers — cleaned up on re-render */
    private scrollers: VirtualScroller<Scene>[] = [];
    /** Saved column scroll positions across refreshes (keyed by group title) */
    private columnScrollPositions: Map<string, number> = new Map();

    constructor(leaf: WorkspaceLeaf, plugin: SceneCardsPlugin, sceneManager: SceneManager) {
        super(leaf);
        this.plugin = plugin;
        this.sceneManager = sceneManager;
        this.cardComponent = new SceneCardComponent(plugin);
        // Restore last used board mode and groupBy
        const s = plugin.settings;
        this.boardMode = s.lastBoardMode || (s.defaultBoardMode === 'kanban' ? 'kanban' : 'corkboard');
        this.groupBy = (s.lastBoardGroupBy as BoardGroupBy) || 'act';
    }

    getViewType(): string {
        return BOARD_VIEW_TYPE;
    }

    getDisplayText(): string {
        const title = this.plugin?.sceneManager?.activeProject?.title;
        return title ? `StoryLine - ${title}` : 'StoryLine';
    }

    getIcon(): string {
        return 'layout-grid';
    }

    async onOpen(): Promise<void> {
        this.plugin.storyLeaf = this.leaf;
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('story-line-board-container');
        applyMobileClass(container);
        this.rootContainer = container;

        await this.sceneManager.initialize();
        this.renderView(container);
    }

    async onClose(): Promise<void> {
        if (this.corkboardInteractionCleanup) {
            this.corkboardInteractionCleanup();
            this.corkboardInteractionCleanup = null;
        }
        if (this.dragToPanCleanup) {
            this.dragToPanCleanup();
            this.dragToPanCleanup = null;
        }
        if (this.corkboardPersistTimer) {
            clearTimeout(this.corkboardPersistTimer);
            this.corkboardPersistTimer = null;
        }
        await this.persistCorkboardLayout();
    }

    /**
     * Render the entire board view
     */
    private renderView(container: HTMLElement): void {
        this.ensureCorkboardLayoutLoaded();
        container.empty();

        // Toolbar
        const toolbar = container.createDiv('story-line-toolbar');
        this.renderToolbar(toolbar);

        // Main content area (board + inspector)
        const mainArea = container.createDiv('story-line-main-area');

        // Filters
        const filterContainer = mainArea.createDiv('story-line-filters-container');
        filterContainer.toggleClass('is-corkboard-mode', this.boardMode === 'corkboard');
        filterContainer.toggleClass('is-kanban-mode', this.boardMode === 'kanban');
        this.filtersComponent = new FiltersComponent(
            filterContainer,
            this.sceneManager,
            (filter, sort) => {
                this.currentFilter = filter;
                this.currentSort = sort;
                this.refreshBoard();
            },
            this.plugin
        );
        this.filtersComponent.render();

        // In Kanban mode, add Group by dropdown to the filter bar
        if (this.boardMode === 'kanban') {
            const filterBar = filterContainer.querySelector('.story-line-filter-bar') as HTMLElement | null;
            if (filterBar) {
                const searchWrapper = filterBar.querySelector('.story-line-search-wrapper');
                const groupContainer = createDiv('story-line-group-control');
                groupContainer.createSpan({ text: 'Group by: ' });
                const groupSelect = groupContainer.createEl('select', { cls: 'dropdown' });
                const groupOptions: { value: BoardGroupBy; label: string }[] = [
                    { value: 'act', label: 'Act' },
                    { value: 'chapter', label: 'Chapter' },
                    { value: 'status', label: 'Status' },
                    { value: 'pov', label: 'POV' },
                ];
                // Append user-defined scene custom fields (dropdown / multi-select only)
                if (this.plugin.fieldTemplates) {
                    const sceneTpls = this.plugin.fieldTemplates.getAll()
                        .filter(t => (t.category || 'character') === 'scene')
                        .filter(t => t.type === 'dropdown' || t.type === 'multi-select');
                    for (const tpl of sceneTpls) {
                        groupOptions.push({ value: `cf:${tpl.id}`, label: tpl.label });
                    }
                }
                groupOptions.forEach(opt => {
                    const option = groupSelect.createEl('option', { text: opt.label, value: opt.value });
                    if (opt.value === this.groupBy) option.selected = true;
                });
                groupSelect.addEventListener('change', () => {
                    this.groupBy = groupSelect.value as BoardGroupBy;
                    this.plugin.settings.lastBoardGroupBy = this.groupBy;
                    this.plugin.saveSettings();
                    this.refreshBoard();
                });
                if (searchWrapper && searchWrapper.nextSibling) {
                    filterBar.insertBefore(groupContainer, searchWrapper.nextSibling);
                } else {
                    filterBar.appendChild(groupContainer);
                }
            }
        }

        // Board
        this.boardEl = mainArea.createDiv('story-line-board');
        this.configureDragToPan();

        // Bulk action bar (hidden until 2+ selected)
        this.bulkBarEl = mainArea.createDiv('story-line-bulk-bar');
        this.bulkBarEl.style.display = 'none';

        this.refreshBoard();

        // Inspector sidebar
        const inspectorEl = mainArea.createDiv('story-line-inspector-panel');
        inspectorEl.style.display = 'none';
        this.inspectorComponent = new InspectorComponent(
            inspectorEl,
            this.plugin,
            this.sceneManager,
            {
                onEdit: (scene) => this.openScene(scene),
                onDelete: (scene) => this.deleteScene(scene),
                onRefresh: () => this.refreshBoard(),
                onStatusChange: async (scene, status) => {
                    await this.sceneManager.updateScene(scene.filePath, { status });
                    this.refreshBoard();
                },
            }
        );
    }

    /**
     * Render the toolbar
     */
    private renderToolbar(toolbar: HTMLElement): void {
        // Clear any previous reference to toolbar controls before re-render
        this.corkboardZoomLabelEl = null;
        this.corkboardAlignControlsEl = null;
        // Title + project selector row
        const titleRow = toolbar.createDiv('story-line-title-row');
        titleRow.createEl('h3', {
            cls: 'story-line-view-title',
            text: 'StoryLine'
        });
        // project name shown in top-center only; no inline project selector here

        // View switcher tabs
        renderViewSwitcher(toolbar, BOARD_VIEW_TYPE, this.plugin, this.leaf);

        const controls = toolbar.createDiv('story-line-toolbar-controls');

        const modeToggle = controls.createDiv('story-line-board-mode-toggle');
        const corkboardBtn = modeToggle.createEl('button', {
            cls: `story-line-board-mode-btn ${this.boardMode === 'corkboard' ? 'active' : ''}`,
            text: 'Corkboard'
        });
        const kanbanBtn = modeToggle.createEl('button', {
            cls: `story-line-board-mode-btn ${this.boardMode === 'kanban' ? 'active' : ''}`,
            text: 'Kanban'
        });
        corkboardBtn.addEventListener('click', () => {
            if (this.boardMode !== 'corkboard') {
                this.boardMode = 'corkboard';
                this.plugin.settings.lastBoardMode = 'corkboard';
                this.plugin.saveSettings();
                if (this.rootContainer) this.renderView(this.rootContainer);
            }
        });
        kanbanBtn.addEventListener('click', () => {
            if (this.boardMode !== 'kanban') {
                this.boardMode = 'kanban';
                this.plugin.settings.lastBoardMode = 'kanban';
                this.plugin.saveSettings();
                if (this.rootContainer) this.renderView(this.rootContainer);
            }
        });

        if (this.boardMode === 'corkboard') {
            const toggleWrap = controls.createEl('label', { cls: 'sl-toggle-wrap' });
            toggleWrap.createSpan({ cls: 'sl-toggle-label', text: 'Scenes' });
            const cb = toggleWrap.createEl('input', { type: 'checkbox' });
            cb.checked = this.plugin.settings.showScenesInCorkboard;
            toggleWrap.createSpan({ cls: 'sl-toggle-track' });
            cb.addEventListener('change', async () => {
                this.plugin.settings.showScenesInCorkboard = cb.checked;
                await this.plugin.saveSettings();
                this.refresh();
            });
        }

        if (this.boardMode === 'kanban') {
            const notesToggleWrap = controls.createEl('label', { cls: 'sl-toggle-wrap' });
            notesToggleWrap.createSpan({ cls: 'sl-toggle-label', text: 'Notes' });
            const notesCb = notesToggleWrap.createEl('input', { type: 'checkbox' });
            notesCb.checked = this.plugin.settings.showNotesInKanban;
            notesToggleWrap.createSpan({ cls: 'sl-toggle-track' });
            notesCb.addEventListener('change', async () => {
                this.plugin.settings.showNotesInKanban = notesCb.checked;
                await this.plugin.saveSettings();
                this.refresh();
            });
        }

        // Add scene button — capture mode at creation time so the handler
        // always routes correctly even if boardMode changes between renders.
        const isCorkboardMode = this.boardMode === 'corkboard';
        const addBtn = controls.createEl('button', {
            cls: 'mod-cta story-line-add-btn',
            text: isCorkboardMode ? '+ New Note' : '+ New Scene'
        });
        addBtn.addEventListener('click', () => {
            if (isCorkboardMode) {
                void this.openQuickAddIdea();
            } else {
                this.openQuickAdd();
            }
        });

        // Add image note button (corkboard only)
        if (this.boardMode === 'corkboard') {
            const imgBtn = controls.createEl('button', {
                cls: 'clickable-icon',
            });
            obsidian.setIcon(imgBtn, 'image-plus');
            attachTooltip(imgBtn, 'New Image Note');
            imgBtn.addEventListener('click', () => {
                void this.openImageNotePicker();
            });
        }

        // Icon button group
        const iconGroup = controls.createDiv('story-line-icon-group');

        // Add acts/chapters button (available in both kanban and corkboard)
        {
            const structBtn = iconGroup.createEl('button', {
                cls: 'clickable-icon',
            });
            if (typeof obsidian.setIcon === 'function') {
                obsidian.setIcon(structBtn, 'columns-3');
            } else {
                console.error('obsidian.setIcon is not defined when setting structBtn');
            }
            attachTooltip(structBtn, 'Beat Sheet Templates / Add acts or chapters');
            structBtn.addEventListener('click', () => this.openStructureModal());
        }

        // Resequence button (kanban only)
        if (this.boardMode !== 'corkboard') {
            const reseqBtn = iconGroup.createEl('button', {
                cls: 'clickable-icon',
            });
            if (typeof obsidian.setIcon === 'function') {
                obsidian.setIcon(reseqBtn, 'list-ordered');
            } else {
                console.error('obsidian.setIcon is not defined when setting reseqBtn');
            }
            attachTooltip(reseqBtn, 'Resequence all scenes');
            reseqBtn.addEventListener('click', async () => {
                const scenes = this.sceneManager.getFilteredScenes(
                    undefined,
                    { field: 'sequence', direction: 'asc' }
                );
                // Sort by act → chapter → current sequence for stable ordering.
                // compareActChapter handles non-numeric acts ("1.1", "Prologue")
                // by falling back to a numeric-aware locale compare.
                const sorted = [...scenes].sort((a, b) => {
                    const actCmp = compareActChapter(a.act, b.act);
                    if (actCmp !== 0) return actCmp;
                    const chCmp = compareActChapter(a.chapter, b.chapter);
                    if (chCmp !== 0) return chCmp;
                    return (a.sequence ?? 0) - (b.sequence ?? 0);
                });
                // Renumber sequence within each (act, chapter) group.
                // Never overwrite chapter — preserve existing chapter assignments.
                // Group key uses String() so non-numeric acts/chapters
                // (e.g. "1.1", "Prologue") group cleanly instead of all
                // collapsing onto the same numeric fallback.
                let prevKey = '\0';
                let seqInGroup = 0;
                for (const scene of sorted) {
                    const key = `${String(scene.act ?? '')}\u0001${String(scene.chapter ?? '')}`;
                    if (key !== prevKey) {
                        seqInGroup = 0; prevKey = key;
                    }
                    seqInGroup++;
                    await this.sceneManager.updateScene(scene.filePath, { sequence: seqInGroup });
                }
                await this.sceneManager.initialize();
                this.refreshBoard();
            });
        }

        // Undo button
        const undoBtn = iconGroup.createEl('button', {
            cls: 'clickable-icon',
        });
        obsidian.setIcon(undoBtn, 'undo');
        attachTooltip(undoBtn, 'Undo (Ctrl+Z)');
        undoBtn.addEventListener('click', async () => {
            await this.sceneManager.undoManager.undo();
        });

        // Redo button
        const redoBtn = iconGroup.createEl('button', {
            cls: 'clickable-icon',
        });
        obsidian.setIcon(redoBtn, 'redo');
        attachTooltip(redoBtn, 'Redo (Ctrl+Shift+Z)');
        redoBtn.addEventListener('click', async () => {
            await this.sceneManager.undoManager.redo();
        });

        // Refresh button
        const refreshBtn = iconGroup.createEl('button', {
            cls: 'clickable-icon',
        });
        if (typeof obsidian.setIcon === 'function') {
            obsidian.setIcon(refreshBtn, 'refresh-cw');
        } else {
            console.error('obsidian.setIcon is not defined when setting refreshBtn');
        }
        attachTooltip(refreshBtn, 'Refresh');
        refreshBtn.addEventListener('click', async () => {
            await this.sceneManager.initialize();
            this.refreshBoard();
        });

        // Archive button
        const archiveBtn = iconGroup.createEl('button', {
            cls: 'clickable-icon',
        });
        obsidian.setIcon(archiveBtn, 'archive');
        attachTooltip(archiveBtn, 'Archived Scenes');
        archiveBtn.addEventListener('click', () => this.openArchiveModal());

        // ── View Snapshots ──
        const snapManage = iconGroup.createDiv({ cls: 'clickable-icon' });
        obsidian.setIcon(snapManage, 'history');
        attachTooltip(snapManage, 'Manage View Snapshots');
        snapManage.addEventListener('click', () => {
            openManageSnapshotsModal(this.plugin.app, this.plugin.viewSnapshotService);
        });

        // Corkboard-only align controls (visible when 2+ selected)
        if (this.boardMode === 'corkboard') {
            const alignWrap = controls.createDiv('story-line-corkboard-align');
            alignWrap.style.display = this.selectedScenes.size >= 2 ? 'flex' : 'none';
            alignWrap.style.gap = '4px';
            alignWrap.style.alignItems = 'center';
            this.corkboardAlignControlsEl = alignWrap;

            const addAlignButton = (label: string, tooltip: string, handler: () => void) => {
                const btn = alignWrap.createEl('button', { cls: 'clickable-icon' });
                btn.createSpan({ text: label });
                attachTooltip(btn, tooltip);
                btn.addEventListener('click', () => {
                    handler();
                });
                return btn;
            };

            addAlignButton('Left', 'Align selected cards to the left', () => this.alignSelectedCorkboardNodes('left'));
            addAlignButton('Top', 'Align selected cards to the top', () => this.alignSelectedCorkboardNodes('top'));
            addAlignButton('H‑Center', 'Align selected cards horizontally', () => this.alignSelectedCorkboardNodes('h-center'));
            addAlignButton('V‑Center', 'Align selected cards vertically', () => this.alignSelectedCorkboardNodes('v-center'));
            addAlignButton('Distribute H', 'Distribute selected cards horizontally', () => this.alignSelectedCorkboardNodes('distribute-h'));
            addAlignButton('Distribute V', 'Distribute selected cards vertically', () => this.alignSelectedCorkboardNodes('distribute-v'));
        }

        // Corkboard connections toggle
        if (this.boardMode === 'corkboard') {
            const connectionsBtn = controls.createEl('button', { cls: 'clickable-icon' });
            attachTooltip(connectionsBtn, 'Toggle connection lines between selected cards');
            obsidian.setIcon(connectionsBtn, 'link');
            if (this.corkboardConnectionsEnabled) {
                connectionsBtn.addClass('is-active');
            }
            connectionsBtn.addEventListener('click', () => {
                this.corkboardConnectionsEnabled = !this.corkboardConnectionsEnabled;
                connectionsBtn.toggleClass('is-active', this.corkboardConnectionsEnabled);
                this.updateCorkboardConnections();
            });
        }

        // Corkboard-only zoom controls (simple: -, percent, +)
        if (this.boardMode === 'corkboard') {
            const zoomWrap = controls.createDiv('story-line-corkboard-zoom');

            const zoomOutBtn = zoomWrap.createEl('button', { cls: 'clickable-icon' });
            try { obsidian.setIcon(zoomOutBtn, 'zoom-out'); } catch (_) {}
            attachTooltip(zoomOutBtn, 'Zoom out');
            zoomOutBtn.addEventListener('click', () => {
                this.corkboardCamera.zoom = Math.max(0.35, (this.corkboardCamera.zoom || 1) * 0.9);
                const canvas = this.boardEl?.querySelector('.story-line-corkboard-canvas') as HTMLElement | null;
                if (canvas) this.applyCorkboardCamera(canvas);
                if (this.corkboardZoomLabelEl) this.corkboardZoomLabelEl.textContent = `${Math.round((this.corkboardCamera.zoom || 1) * 100)}%`;
            });

            // Reset (1:1) button
            const resetBtn = zoomWrap.createEl('button', { cls: 'clickable-icon' });
            resetBtn.createSpan({ text: '1:1' });
            attachTooltip(resetBtn, 'Reset zoom to 100% and center');
            resetBtn.addEventListener('click', () => {
                const canvas = this.boardEl?.querySelector('.story-line-corkboard-canvas') as HTMLElement | null;
                const viewport = this.boardEl?.querySelector('.story-line-corkboard-viewport') as HTMLElement | null;
                if (!canvas || !viewport) return;
                // Determine target nodes: selected, else all visible nodes
                const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.story-line-corkboard-node'))
                    .filter(n => {
                        if (this.selectedScenes.size > 0) return this.selectedScenes.has(n.dataset.filePath || '');
                        return true;
                    });
                if (nodes.length === 0) return;
                // Compute world bounding box using node.style left/top and offset sizes
                let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
                for (const n of nodes) {
                    const left = parseFloat(n.style.left || '0') || 0;
                    const top = parseFloat(n.style.top || '0') || 0;
                    const w = n.offsetWidth || 200;
                    const h = n.offsetHeight || 120;
                    minX = Math.min(minX, left);
                    minY = Math.min(minY, top);
                    maxX = Math.max(maxX, left + w);
                    maxY = Math.max(maxY, top + h);
                }
                const worldCenterX = (minX + maxX) / 2;
                const worldCenterY = (minY + maxY) / 2;
                this.corkboardCamera.zoom = 1;
                const vw = viewport.clientWidth;
                const vh = viewport.clientHeight;
                this.corkboardCamera.x = vw / 2 - worldCenterX * this.corkboardCamera.zoom;
                this.corkboardCamera.y = vh / 2 - worldCenterY * this.corkboardCamera.zoom;
                this.applyCorkboardCamera(canvas);
            });

            // Fit button
            const fitBtn = zoomWrap.createEl('button', { cls: 'clickable-icon' });
            fitBtn.createSpan({ text: 'Fit' });
            attachTooltip(fitBtn, 'Fit all visible cards into view');
            fitBtn.addEventListener('click', () => {
                const canvas = this.boardEl?.querySelector('.story-line-corkboard-canvas') as HTMLElement | null;
                const viewport = this.boardEl?.querySelector('.story-line-corkboard-viewport') as HTMLElement | null;
                if (!canvas || !viewport) return;
                const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.story-line-corkboard-node'))
                    .filter(n => {
                        // Exclude nodes that are not currently displayed in canvas
                        return true;
                    });
                if (nodes.length === 0) return;
                let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
                for (const n of nodes) {
                    const left = parseFloat(n.style.left || '0') || 0;
                    const top = parseFloat(n.style.top || '0') || 0;
                    const w = n.offsetWidth || 200;
                    const h = n.offsetHeight || 120;
                    minX = Math.min(minX, left);
                    minY = Math.min(minY, top);
                    maxX = Math.max(maxX, left + w);
                    maxY = Math.max(maxY, top + h);
                }
                const bboxW = Math.max(1, maxX - minX);
                const bboxH = Math.max(1, maxY - minY);
                const padding = 80;
                const vw = viewport.clientWidth;
                const vh = viewport.clientHeight;
                const scaleX = vw / (bboxW + padding);
                const scaleY = vh / (bboxH + padding);
                const targetZoom = Math.max(0.35, Math.min(2.8, Math.min(scaleX, scaleY)));
                const worldCenterX = (minX + maxX) / 2;
                const worldCenterY = (minY + maxY) / 2;
                this.corkboardCamera.zoom = targetZoom;
                this.corkboardCamera.x = vw / 2 - worldCenterX * this.corkboardCamera.zoom;
                this.corkboardCamera.y = vh / 2 - worldCenterY * this.corkboardCamera.zoom;
                this.applyCorkboardCamera(canvas);
            });

            const zoomLabel = zoomWrap.createDiv('story-line-corkboard-zoom-label');
            zoomLabel.textContent = `${Math.round((this.corkboardCamera.zoom || 1) * 100)}%`;
            this.corkboardZoomLabelEl = zoomLabel;

            const zoomInBtn = zoomWrap.createEl('button', { cls: 'clickable-icon' });
            try { obsidian.setIcon(zoomInBtn, 'zoom-in'); } catch (_) {}
            attachTooltip(zoomInBtn, 'Zoom in');
            zoomInBtn.addEventListener('click', () => {
                this.corkboardCamera.zoom = Math.max(0.35, Math.min(2.8, (this.corkboardCamera.zoom || 1) * 1.1));
                const canvas = this.boardEl?.querySelector('.story-line-corkboard-canvas') as HTMLElement | null;
                if (canvas) this.applyCorkboardCamera(canvas);
                if (this.corkboardZoomLabelEl) this.corkboardZoomLabelEl.textContent = `${Math.round((this.corkboardCamera.zoom || 1) * 100)}%`;
            });
        }
    }

    /**
     * Save scroll positions of all Kanban column bodies before a re-render.
     */
    private saveColumnScrollPositions(): void {
        this.columnScrollPositions.clear();
        if (!this.boardEl) return;
        const columns = this.boardEl.querySelectorAll('.story-line-column');
        columns.forEach((col) => {
            const group = col.getAttribute('data-group');
            const body = col.querySelector('.story-line-column-body') as HTMLElement | null;
            if (group && body) {
                this.columnScrollPositions.set(group, body.scrollTop);
            }
        });
    }

    /**
     * Restore previously saved scroll positions after a re-render.
     */
    private restoreColumnScrollPositions(): void {
        if (!this.boardEl || this.columnScrollPositions.size === 0) return;
        const columns = this.boardEl.querySelectorAll('.story-line-column');
        columns.forEach((col) => {
            const group = col.getAttribute('data-group');
            const body = col.querySelector('.story-line-column-body') as HTMLElement | null;
            if (group && body && this.columnScrollPositions.has(group)) {
                body.scrollTop = this.columnScrollPositions.get(group)!;
            }
        });
    }

    /**
     * Render the board columns
     */
    private renderBoard(): void {
        if (!this.boardEl) return;
        this.boardEl.removeClass('story-line-corkboard');
        this.boardEl.empty();

        // Destroy previous virtual scrollers
        for (const vs of this.scrollers) vs.destroy();
        this.scrollers = [];

        const groups = this.sceneManager.getScenesGroupedByWithEmpty(
            this.groupBy,
            this.currentFilter,
            this.currentSort
        );

        // Sort group keys
        const sortedKeys = this.sortGroupKeys(Array.from(groups.keys()));

        if (sortedKeys.length === 0) {
            const empty = this.boardEl.createDiv('story-line-empty');
            empty.createEl('p', { text: 'No scenes found.' });
            empty.createEl('p', { text: 'Click "+ New Scene" to create your first scene, or check your Scene folder setting.' });
            return;
        }

        for (const key of sortedKeys) {
            let scenes = groups.get(key) || [];
            if (!this.plugin.settings.showNotesInKanban) {
                scenes = scenes.filter(scene => !this.isCorkboardNoteScene(scene));
                const isNoActColumn = this.groupBy === 'act' && key.trim().toLowerCase() === 'no act';
                if (isNoActColumn && scenes.length === 0) {
                    continue;
                }
            }
            this.renderColumn(this.boardEl, key, scenes);
        }
    }

    private renderCorkboard(): void {
        if (!this.boardEl) return;

        if (this.corkboardInteractionCleanup) {
            this.corkboardInteractionCleanup();
            this.corkboardInteractionCleanup = null;
        }

        this.boardEl.empty();
        this.boardEl.addClass('story-line-corkboard');

        // Destroy previous virtual scrollers (used by Kanban mode)
        for (const vs of this.scrollers) vs.destroy();
        this.scrollers = [];

        let scenes = this.sceneManager.getFilteredScenes(this.currentFilter, this.currentSort);
        if (!this.plugin.settings.showScenesInCorkboard) {
            scenes = scenes.filter(scene => this.isCorkboardNoteScene(scene));
        }
        // Only render nodes for visible scenes, but keep positions for
        // filtered-out scenes so they don't lose their layout.
        const validPaths = new Set(scenes.map(s => s.filePath));

        const currentMaxZ = () => {
            let max = 0;
            for (const pos of this.corkboardPositions.values()) {
                if ((pos.z ?? 0) > max) max = pos.z ?? 0;
            }
            return max;
        };

        if (scenes.length === 0) {
            const empty = this.boardEl.createDiv('story-line-empty');
            empty.createEl('p', { text: 'No scenes found.' });
            empty.createEl('p', { text: 'Click "+ New Scene" to create your first scene, or adjust your filters.' });
            return;
        }

        const viewport = this.boardEl.createDiv('story-line-corkboard-viewport');
        // ensure viewport is a positioned container so absolute children (minimap)
        // are constrained to it and won't be placed off-screen; hide overflow
        viewport.style.position = 'relative';
        viewport.style.overflow = 'hidden';
        const canvas = viewport.createDiv('story-line-corkboard-canvas');

        // Create SVG overlay for temporary corkboard connections (above canvas, below cards)
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.style.position = 'absolute';
        svg.style.inset = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.overflow = 'visible';
        svg.style.pointerEvents = 'none';
        svg.style.zIndex = '10'; // Above canvas background, below cards (cards are 1+)
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('preserveAspectRatio', 'none');
        viewport.appendChild(svg);
        this.corkboardConnectionSvg = svg;

        // Create a small non-interactive minimap overlay (bottom-right)
        const minimapWrap = viewport.createDiv('story-line-corkboard-minimap');
        // Explicit inline styles required to ensure minimap stays inside viewport
        minimapWrap.style.position = 'absolute';
        minimapWrap.style.right = '48px';
        minimapWrap.style.bottom = '120px';
        minimapWrap.style.width = '180px';
        minimapWrap.style.height = '110px';
        minimapWrap.style.zIndex = '50';
        minimapWrap.style.pointerEvents = 'auto';
        minimapWrap.style.boxSizing = 'border-box';
        minimapWrap.style.border = '1px solid rgba(0,0,0,0.12)';
        minimapWrap.style.background = 'rgba(255,255,255,0.06)';
        const stopMinimapEvent = (ev: Event) => {
            ev.preventDefault();
            ev.stopPropagation();
        };

        ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'wheel', 'click'].forEach(type => {
            minimapWrap.addEventListener(type, stopMinimapEvent, true);
        });
        const mmCanvas = minimapWrap.createEl('canvas') as HTMLCanvasElement;
        mmCanvas.style.cursor = 'pointer';
        mmCanvas.style.width = '100%';
        mmCanvas.style.height = '100%';
        mmCanvas.style.display = 'block';
        this.corkboardMinimapCanvas = mmCanvas;

        // Capture pointerdown on the minimap wrapper to fully prevent
        // the corkboard viewport from receiving the event and to perform
        // click-to-pan and drag-to-pan behavior. Use capture phase to stop upstream handlers.
        minimapWrap.addEventListener('pointerdown', (ev: PointerEvent) => {
            ev.preventDefault();
            ev.stopPropagation();

            const mm = this.corkboardMinimapCanvas;
            const viewport = this.boardEl?.querySelector('.story-line-corkboard-viewport') as HTMLElement | null;
            const canvasEl = this.boardEl?.querySelector('.story-line-corkboard-canvas') as HTMLElement | null;
            if (!mm || !viewport || !canvasEl) return;

            const computeAndCenter = (clientX: number, clientY: number) => {
                const rect = mm.getBoundingClientRect();
                const localX = clientX - rect.left;
                const localY = clientY - rect.top;
                const w = rect.width;
                const h = rect.height;

                const nodes = Array.from(canvasEl.querySelectorAll<HTMLElement>('.story-line-corkboard-node'));
                if (nodes.length === 0) return;
                let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
                for (const n of nodes) {
                    const left = parseFloat(n.style.left || '0') || 0;
                    const top = parseFloat(n.style.top || '0') || 0;
                    const wN = n.offsetWidth || 200;
                    const hN = n.offsetHeight || 120;
                    minX = Math.min(minX, left);
                    minY = Math.min(minY, top);
                    maxX = Math.max(maxX, left + wN);
                    maxY = Math.max(maxY, top + hN);
                }
                const padding = 40;
                minX -= padding; minY -= padding; maxX += padding; maxY += padding;
                const bboxW = Math.max(1, maxX - minX);
                const bboxH = Math.max(1, maxY - minY);

                const scale = Math.min((w - 6) / bboxW, (h - 6) / bboxH);
                const ox = (w - bboxW * scale) / 2 - minX * scale;
                const oy = (h - bboxH * scale) / 2 - minY * scale;

                const worldX = (localX - ox) / scale;
                const worldY = (localY - oy) / scale;

                const zoom = this.corkboardCamera.zoom || 1;
                this.corkboardCamera.x = viewport.clientWidth / 2 - worldX * zoom;
                this.corkboardCamera.y = viewport.clientHeight / 2 - worldY * zoom;
            };

            // Apply immediately for the initial pointerdown (click behavior)
            computeAndCenter(ev.clientX, ev.clientY);
            this.applyCorkboardCamera(canvasEl);

            // Start drag tracking
            let dragging = true;

            const onMove = (e: PointerEvent) => {
                if (!dragging) return;
                e.preventDefault();
                e.stopPropagation();
                computeAndCenter(e.clientX, e.clientY);
                this.applyCorkboardCamera(canvasEl);
            };

            const onUp = (e: PointerEvent) => {
                if (!dragging) return;
                dragging = false;
                e.preventDefault();
                e.stopPropagation();
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', onUp, true);
                window.removeEventListener('pointercancel', onUp, true);
            };

            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onUp, true);
        }, true);

        this.corkboardInteractionCleanup = this.enableCorkboardCameraInteraction(viewport, canvas);
        this.applyCorkboardCamera(canvas);

        // ── Drag-and-drop images onto the corkboard ──
        this.attachCorkboardImageDrop(viewport);
        this.attachCorkboardLassoSelection(viewport);

        scenes.forEach((scene, index) => {
          try {
            const existing = this.corkboardPositions.get(scene.filePath);
            const col = index % 4;
            const row = Math.floor(index / 4);
            const pos = existing || {
                x: col * 320,
                y: row * 230,
                z: currentMaxZ() + 1,
            };
            if (!existing) {
                this.corkboardPositions.set(scene.filePath, pos);
                if (this._corkboardProjectLoaded) this.schedulePersistCorkboardLayout();
            } else if (!Number.isFinite(existing.z)) {
                pos.z = currentMaxZ() + 1;
                this.corkboardPositions.set(scene.filePath, pos);
                if (this._corkboardProjectLoaded) this.schedulePersistCorkboardLayout();
            }

            const node = canvas.createDiv('story-line-corkboard-node');
            node.setAttribute('data-file-path', scene.filePath);
            node.style.left = `${pos.x}px`;
            node.style.top = `${pos.y}px`;
            node.style.zIndex = String(pos.z ?? 1);
            if (this.isCorkboardNoteScene(scene)) {
                node.addClass('story-line-corkboard-note-node');
            }

            const cardEl = this.cardComponent.render(scene, node, {
                compact: false,
                onSelect: (s, event) => {
                    if (this.isCorkboardNoteScene(s)) return;
                    if (this.corkboardJustDragged.has(s.filePath)) return;
                    this.selectScene(s, event);
                },
                onDoubleClick: (s) => {
                    if (this.isCorkboardNoteScene(s)) return;
                    this.openScene(s);
                },
                onContextMenu: (s, event) => {
                    if (this.isCorkboardNoteScene(s)) {
                        this.showCorkboardNoteMenu(s, event);
                    } else {
                        this.showContextMenu(s, event);
                    }
                },
                draggable: false,
            });
            cardEl.addClass('story-line-corkboard-card');

            if (this.selectedScenes.has(scene.filePath)) {
                cardEl.addClass('selected');
            }

            // Restore persisted height from layout data (only for note cards)
            if (pos.h && pos.h > 0 && this.isCorkboardNoteScene(scene)) {
                cardEl.style.height = `${pos.h}px`;
            }

            this.attachCorkboardNoteEditor(cardEl, scene);

            this.attachCorkboardDrag(node, scene.filePath);
          } catch (err) {
            console.error(`[StoryLine] Failed to render corkboard scene "${scene.filePath}":`, err);
          }
        });

        if (this.boardMode === 'corkboard') {
            this.updateCorkboardConnections();
        }
    }

    private attachCorkboardNoteEditor(cardEl: HTMLElement, scene: Scene): void {
        // Only explicit corkboard notes get inline note editor
        if (!this.isCorkboardNoteScene(scene)) return;

        cardEl.addClass('story-line-corkboard-note-card');
        this.applyCorkboardNoteColor(cardEl, scene);

        // ── Image note rendering ───────────────────────────
        if (scene.corkboardNoteImage) {
            cardEl.addClass('story-line-corkboard-image-note');
            this.renderImageNoteContent(cardEl, scene);
            return;
        }

        const editorWrap = cardEl.createDiv('story-line-corkboard-note-editor');

        // Show plotgrid origin label if present
        if (scene.plotgridOrigin) {
            const originEl = editorWrap.createDiv('story-line-corkboard-note-origin');
            const originIcon = originEl.createSpan({ cls: 'story-line-corkboard-note-origin-icon' });
            obsidian.setIcon(originIcon, 'sticky-note');
            originEl.createSpan({ text: scene.plotgridOrigin });
        }

        const textarea = editorWrap.createEl('textarea', {
            cls: 'story-line-corkboard-note-text',
            attr: {
                placeholder: 'Write your note…',
                rows: '6',
            },
        });
        textarea.value = scene.body || '';

        const preview = editorWrap.createDiv('story-line-corkboard-note-preview markdown-rendered');
        let isEditing = false;
        let commitInProgress = false;
        let outsidePointerHandler: ((event: PointerEvent) => void) | null = null;

        const detachOutsideClose = () => {
            if (!outsidePointerHandler) return;
            document.removeEventListener('pointerdown', outsidePointerHandler, true);
            outsidePointerHandler = null;
        };

        const renderPreview = async () => {
            preview.empty();
            const source = textarea.value.trim();
            if (!source) {
                preview.createDiv({ cls: 'story-line-corkboard-note-preview-empty', text: 'Write your note…' });
                return;
            }
            await MarkdownRenderer.render(this.app, source, preview, scene.filePath, this);
        };

        const placeCaretFromClick = (clientX: number, clientY: number) => {
            const docAny = document as Document & {
                caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
                caretRangeFromPoint?: (x: number, y: number) => Range | null;
            };

            let offset: number | null = null;
            const textNode = textarea.firstChild;

            if (typeof docAny.caretPositionFromPoint === 'function') {
                const pos = docAny.caretPositionFromPoint(clientX, clientY);
                if (pos && (pos.offsetNode === textNode || pos.offsetNode === textarea)) {
                    offset = pos.offset;
                }
            }

            if (offset === null && typeof docAny.caretRangeFromPoint === 'function') {
                const range = docAny.caretRangeFromPoint(clientX, clientY);
                if (range && (range.startContainer === textNode || range.startContainer === textarea)) {
                    offset = range.startOffset;
                }
            }

            if (offset === null) {
                const rect = textarea.getBoundingClientRect();
                const yRatio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
                offset = Math.round(textarea.value.length * yRatio);
            }

            const clamped = Math.max(0, Math.min(textarea.value.length, offset));
            textarea.setSelectionRange(clamped, clamped);
        };

        const setEditing = (editing: boolean, clickPoint?: { x: number; y: number }) => {
            isEditing = editing;
            if (editing) {
                preview.style.display = 'none';
                textarea.style.display = 'block';
                autoGrow();
                textarea.focus();
                if (clickPoint) {
                    window.requestAnimationFrame(() => {
                        placeCaretFromClick(clickPoint.x, clickPoint.y);
                    });
                }

                outsidePointerHandler = (event: PointerEvent) => {
                    const target = event.target as Node | null;
                    if (!isEditing) return;
                    if (target && cardEl.contains(target)) return;
                    void commitAndClose();
                };
                window.setTimeout(() => {
                    if (outsidePointerHandler) {
                        document.addEventListener('pointerdown', outsidePointerHandler, true);
                    }
                }, 0);
            } else {
                detachOutsideClose();
                textarea.style.display = 'none';
                preview.style.display = 'block';
            }
        };

        const autoGrow = () => {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.max(96, textarea.scrollHeight)}px`;
        };
        autoGrow();

        const saveBody = async () => {
            const next = textarea.value;
            if ((scene.body || '') === next) return;
            await this.sceneManager.updateScene(scene.filePath, { body: next });
            scene.body = next;
        };

        const commitAndClose = async () => {
            if (!isEditing || commitInProgress) return;
            commitInProgress = true;
            await saveBody();
            await renderPreview();
            setEditing(false);
            commitInProgress = false;
        };

        textarea.addEventListener('input', () => {
            autoGrow();
        });

        textarea.addEventListener('blur', () => {
            void commitAndClose();
        });

        textarea.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                void commitAndClose();
            }
        });

        preview.addEventListener('click', (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            const link = target.closest('a');
            if (link) {
                const href = link.getAttribute('data-href') || link.getAttribute('href');
                if (href && link.hasClass('internal-link')) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.app.workspace.openLinkText(href, scene.filePath, true);
                    return;
                }
                if (href && !href.startsWith('#')) {
                    return; // let external links behave normally
                }
            }
            setEditing(true, { x: event.clientX, y: event.clientY });
        });

        void (async () => {
            await renderPreview();
            setEditing(false);
        })();

        const footer = editorWrap.createDiv('story-line-corkboard-note-actions');
        const convertBtn = footer.createEl('button', {
            cls: 'story-line-corkboard-convert-btn',
            attr: {
                title: 'Convert to scene',
            },
        });
        obsidian.setIcon(convertBtn, 'clapperboard');
        convertBtn.addEventListener('click', async () => {
            await saveBody();
            await this.convertCorkboardNoteToScene(scene);
        });

        const resizeHandle = cardEl.createDiv('story-line-corkboard-note-resize-handle');
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const startY = e.clientY;
            const zoom = this.corkboardCamera.zoom || 1;
            const startHeight = cardEl.getBoundingClientRect().height / zoom;
            const minHeight = 220;

            const onMove = (moveEvent: PointerEvent) => {
                const nextHeight = Math.max(minHeight, startHeight + (moveEvent.clientY - startY) / zoom);
                cardEl.style.height = `${nextHeight}px`;
            };

            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                const finalHeight = parseFloat(cardEl.style.height);
                if (finalHeight > 0) {
                    const pos = this.corkboardPositions.get(scene.filePath);
                    if (pos) {
                        pos.h = finalHeight;
                        this.schedulePersistCorkboardLayout();
                    }
                }
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
    }

    private async convertCorkboardNoteToScene(scene: Scene): Promise<void> {
        const oldPath = scene.filePath;
        const newPath = await this.sceneManager.moveNoteToSceneFolder(oldPath);
        // Update corkboard position key if the file moved
        if (newPath !== oldPath) {
            const pos = this.corkboardPositions.get(oldPath);
            if (pos) {
                this.corkboardPositions.delete(oldPath);
                this.corkboardPositions.set(newPath, pos);
                this.schedulePersistCorkboardLayout();
            }
        }
        scene.corkboardNote = false;
        scene.plotgridOrigin = undefined;
        scene.filePath = newPath;
        this.refreshBoard();
    }

    /**
     * Duplicate a corkboard sticky note, preserving its body and color.
     */
    private async duplicateCorkboardNote(scene: Scene): Promise<void> {
        const file = await this.sceneManager.createScene({
            status: 'idea',
            corkboardNote: true,
            body: scene.body || '',
            corkboardNoteColor: scene.corkboardNoteColor,
        });

        // Position the duplicate offset from the original
        const origPos = this.corkboardPositions.get(scene.filePath);
        const pos = origPos
            ? { x: origPos.x + 30, y: origPos.y + 30, z: this.getCurrentMaxCorkboardZ() + 1 }
            : this.getNextQuickNotePosition();
        this.corkboardPositions.set(file.path, pos);
        this.schedulePersistCorkboardLayout();

        this.refreshBoard();
        new Notice('Note duplicated');
    }

    private isCorkboardNoteScene(scene: Scene): boolean {
        const value: unknown = (scene as Scene & { corkboardNote?: unknown }).corkboardNote;
        if (value === true) return true;
        if (value === false || value === undefined || value === null) return false;
        if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
        if (typeof value === 'number') return value === 1;
        return false;
    }

    private attachCorkboardDrag(node: HTMLElement, scenePath: string): void {
        let dragging = false;
        let startClientX = 0;
        let startClientY = 0;
        let moved = false;
        let dragRaf: number | null = null;
        let pendingDx = 0;
        let pendingDy = 0;
        let lastClickTime = 0;
        const dragStartPositions = new Map<string, { x: number; y: number; z: number }>();
        const dragNodes = new Map<string, HTMLElement>();

        const applyDragPosition = () => {
            dragRaf = null;
            const zoom = this.corkboardCamera.zoom || 1;
            for (const [path, pos] of dragStartPositions.entries()) {
                const newX = pos.x + pendingDx / zoom;
                const newY = pos.y + pendingDy / zoom;
                const dragNode = dragNodes.get(path);
                if (dragNode) {
                    dragNode.style.left = `${newX}px`;
                    dragNode.style.top = `${newY}px`;
                }
                this.corkboardPositions.set(path, { x: newX, y: newY, z: pos.z });
            }
            if (this.boardMode === 'corkboard') {
                this.updateCorkboardConnections();
            }
        };

        const onPointerMove = (e: PointerEvent) => {
            if (!dragging) return;

            const dx = e.clientX - startClientX;
            const dy = e.clientY - startClientY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;

            pendingDx = dx;
            pendingDy = dy;

            if (dragRaf === null) {
                dragRaf = requestAnimationFrame(applyDragPosition);
            }

            e.preventDefault();
            e.stopPropagation();
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            dragStartPositions.clear();
            dragNodes.forEach((dragNode) => dragNode.removeClass('is-dragging'));
            dragNodes.clear();
            if (node.hasPointerCapture(e.pointerId)) {
                node.releasePointerCapture(e.pointerId);
            }
            // Flush any pending rAF
            if (dragRaf !== null) {
                cancelAnimationFrame(dragRaf);
                dragRaf = null;
                applyDragPosition();
            }

            // Remove global listeners added during pointerdown
            try {
                window.removeEventListener('pointermove', onPointerMove, true);
                window.removeEventListener('pointerup', onPointerUp, true);
                window.removeEventListener('pointercancel', onPointerUp, true);
            } catch (_) {}

            if (moved) {
                this.corkboardJustDragged.add(scenePath);
                window.setTimeout(() => this.corkboardJustDragged.delete(scenePath), 180);
                this.schedulePersistCorkboardLayout();
            } else {
                const scene = this.sceneManager.getScene(scenePath);
                if (scene && !this.isCorkboardNoteScene(scene)) {
                    const now = Date.now();
                    if (now - lastClickTime < 400) {
                        this.openScene(scene);
                        lastClickTime = 0;
                    } else {
                        lastClickTime = now;
                        this.selectScene(scene, e);
                    }
                }
            }
        };

        node.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;

            const target = e.target as HTMLElement;
            if (target.closest('button, a, input, textarea, select, img')) return;
            if (target.closest('.story-line-corkboard-note-preview, .story-line-corkboard-note-caption, .story-line-corkboard-note-caption-empty')) return;

            const noteCard = target.closest('.story-line-corkboard-note-card') as HTMLElement | null;
            if (noteCard) {
                const rect = noteCard.getBoundingClientRect();
                const resizeGripSize = 20;
                const isInResizeCorner = e.clientX >= rect.right - resizeGripSize && e.clientY >= rect.bottom - resizeGripSize;
                if (isInResizeCorner) return;
            }

            dragging = true;
            moved = false;
            startClientX = e.clientX;
            startClientY = e.clientY;
            pendingDx = 0;
            pendingDy = 0;

            const selectedPaths = this.selectedScenes.has(scenePath)
                ? Array.from(this.selectedScenes).filter(path => !!this.boardEl?.querySelector(`[data-file-path="${CSS.escape(path)}"]`))
                : [scenePath];

            for (const path of selectedPaths) {
                const dragNode = this.boardEl?.querySelector(`[data-file-path="${CSS.escape(path)}"]`) as HTMLElement | null;
                if (!dragNode) continue;
                const styleLeft = parseFloat(dragNode.style.left || '0') || 0;
                const styleTop = parseFloat(dragNode.style.top || '0') || 0;
                const z = Number.parseInt(dragNode.style.zIndex || '1', 10) || 1;
                dragStartPositions.set(path, { x: styleLeft, y: styleTop, z });
                dragNodes.set(path, dragNode);
                dragNode.addClass('is-dragging');
            }

            node.setPointerCapture(e.pointerId);
            // Ensure we still receive pointer events even if pointer leaves
            // the node or capture is interrupted — listen on window (capture).
            window.addEventListener('pointermove', onPointerMove, true);
            window.addEventListener('pointerup', onPointerUp, true);
            window.addEventListener('pointercancel', onPointerUp, true);
            e.preventDefault();
            e.stopPropagation();
        });

        node.addEventListener('pointermove', onPointerMove);
        node.addEventListener('pointerup', onPointerUp);
        node.addEventListener('pointercancel', onPointerUp);
    }

    private applyCorkboardCamera(canvas: HTMLElement): void {
        canvas.style.transform = `translate(${this.corkboardCamera.x}px, ${this.corkboardCamera.y}px) scale(${this.corkboardCamera.zoom})`;
        if (this.corkboardZoomLabelEl) {
            this.corkboardZoomLabelEl.textContent = `${Math.round((this.corkboardCamera.zoom || 1) * 100)}%`;
        }
        // Update minimap rendering if present
        try {
            this.updateCorkboardMinimap();
        } catch (err) {
            // keep behaviour robust — minimap failures shouldn't break camera
            // eslint-disable-next-line no-console
            console.error('[StoryLine] minimap update failed', err);
        }
        // Update connections rendering if present
        try {
            this.updateCorkboardConnections();
        } catch (err) {
            // keep behaviour robust — connection failures shouldn't break camera
            // eslint-disable-next-line no-console
            console.error('[StoryLine] connections update failed', err);
        }
    }

    private getSelectedVisibleCorkboardNodes(): HTMLElement[] {
        const canvas = this.boardEl?.querySelector('.story-line-corkboard-canvas') as HTMLElement | null;
        if (!canvas) return [];
        return Array.from(canvas.querySelectorAll<HTMLElement>('.story-line-corkboard-node'))
            .filter(node => this.selectedScenes.has(node.dataset.filePath || ''));
    }

    private alignSelectedCorkboardNodes(action: 'left' | 'top' | 'h-center' | 'v-center' | 'distribute-h' | 'distribute-v'): void {
        const nodes = this.getSelectedVisibleCorkboardNodes();
        if (nodes.length < 2) return;

        const items = nodes.map(node => {
            const left = parseFloat(node.style.left || '0') || 0;
            const top = parseFloat(node.style.top || '0') || 0;
            const width = node.offsetWidth || 200;
            const height = node.offsetHeight || 120;
            return {
                node,
                path: node.dataset.filePath || '',
                left,
                top,
                width,
                height,
                centerX: left + width / 2,
                centerY: top + height / 2,
                z: this.corkboardPositions.get(node.dataset.filePath || '')?.z ?? 1,
                h: this.corkboardPositions.get(node.dataset.filePath || '')?.h,
            };
        });

        if (items.length < 2) return;

        const centerXs = items.map(item => item.centerX);
        const centerYs = items.map(item => item.centerY);
        const lefts = items.map(item => item.left);
        const tops = items.map(item => item.top);
        const minLeft = Math.min(...lefts);
        const minTop = Math.min(...tops);
        const avgCenterX = centerXs.reduce((sum, x) => sum + x, 0) / centerXs.length;
        const avgCenterY = centerYs.reduce((sum, y) => sum + y, 0) / centerYs.length;
        const sortedByLeft = [...items].sort((a, b) => a.left - b.left);
        const sortedByTop = [...items].sort((a, b) => a.top - b.top);

        const updatePosition = (item: typeof items[number], nextLeft: number, nextTop: number) => {
            item.node.style.left = `${nextLeft}px`;
            item.node.style.top = `${nextTop}px`;
            this.corkboardPositions.set(item.path, {
                x: nextLeft,
                y: nextTop,
                z: item.z,
                h: item.h,
            });
        };

        if (action === 'left') {
            for (const item of items) {
                updatePosition(item, minLeft, item.top);
            }
        } else if (action === 'top') {
            for (const item of items) {
                updatePosition(item, item.left, minTop);
            }
        } else if (action === 'h-center') {
            for (const item of items) {
                updatePosition(item, avgCenterX - item.width / 2, item.top);
            }
        } else if (action === 'v-center') {
            for (const item of items) {
                updatePosition(item, item.left, avgCenterY - item.height / 2);
            }
        } else if (action === 'distribute-h') {
            const minCenter = Math.min(...centerXs);
            const maxCenter = Math.max(...centerXs);
            const step = (maxCenter - minCenter) / (items.length - 1);
            sortedByLeft.forEach((item, index) => {
                const nextCenter = minCenter + step * index;
                updatePosition(item, nextCenter - item.width / 2, item.top);
            });
        } else if (action === 'distribute-v') {
            const minCenter = Math.min(...centerYs);
            const maxCenter = Math.max(...centerYs);
            const step = (maxCenter - minCenter) / (items.length - 1);
            sortedByTop.forEach((item, index) => {
                const nextCenter = minCenter + step * index;
                updatePosition(item, item.left, nextCenter - item.height / 2);
            });
        }

        this.schedulePersistCorkboardLayout();
        this.refreshBoard();
    }

    private updateCorkboardAlignControls(): void {
        if (!this.corkboardAlignControlsEl) return;
        const visible = this.boardMode === 'corkboard' && this.selectedScenes.size >= 2;
        this.corkboardAlignControlsEl.style.display = visible ? 'flex' : 'none';
        Array.from(this.corkboardAlignControlsEl.querySelectorAll('button')).forEach((btn) => {
            btn.toggleAttribute('disabled', !visible);
        });
    }

    /** Render/update the simple non-interactive minimap */
    private updateCorkboardMinimap(): void {
        const mm = this.corkboardMinimapCanvas;
        const viewport = this.boardEl?.querySelector('.story-line-corkboard-viewport') as HTMLElement | null;
        const canvas = this.boardEl?.querySelector('.story-line-corkboard-canvas') as HTMLElement | null;
        if (!mm || !viewport || !canvas) return;

        const rect = mm.getBoundingClientRect();
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const w = Math.floor(rect.width);
        const h = Math.floor(rect.height);
        mm.width = Math.max(1, Math.floor(w * dpr));
        mm.height = Math.max(1, Math.floor(h * dpr));
        const ctx = mm.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.story-line-corkboard-node'));
        if (nodes.length === 0) return;

        // Compute world bounding box of visible nodes
        let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
        for (const n of nodes) {
            const left = parseFloat(n.style.left || '0') || 0;
            const top = parseFloat(n.style.top || '0') || 0;
            const wN = n.offsetWidth || 200;
            const hN = n.offsetHeight || 120;
            minX = Math.min(minX, left);
            minY = Math.min(minY, top);
            maxX = Math.max(maxX, left + wN);
            maxY = Math.max(maxY, top + hN);
        }

        // Add a small padding in world units
        const padding = 40;
        minX -= padding; minY -= padding; maxX += padding; maxY += padding;

        const bboxW = Math.max(1, maxX - minX);
        const bboxH = Math.max(1, maxY - minY);

        // Compute scale from world -> minimap
        const scale = Math.min((w - 6) / bboxW, (h - 6) / bboxH);
        const ox = (w - bboxW * scale) / 2 - minX * scale;
        const oy = (h - bboxH * scale) / 2 - minY * scale;

        // Draw background
        ctx.fillStyle = 'rgba(0,0,0,0.06)';
        ctx.fillRect(0, 0, w, h);

        // Draw nodes as small rectangles. Highlight selected nodes brighter.
        for (const n of nodes) {
            const left = parseFloat(n.style.left || '0') || 0;
            const top = parseFloat(n.style.top || '0') || 0;
            const wN = n.offsetWidth || 200;
            const hN = n.offsetHeight || 120;
            const x = left * scale + ox;
            const y = top * scale + oy;
            const rw = Math.max(2, wN * scale);
            const rh = Math.max(2, hN * scale);
            const path = n.dataset.filePath || '';
            if (this.selectedScenes.has(path)) {
                ctx.fillStyle = 'rgba(255,80,80,0.95)';
            } else {
                ctx.fillStyle = 'rgba(50,50,50,0.5)';
            }
            ctx.fillRect(x, y, rw, rh);
        }

        // Draw viewport rectangle in world coords
        const zoom = this.corkboardCamera.zoom || 1;
        const worldLeft = -this.corkboardCamera.x / zoom;
        const worldTop = -this.corkboardCamera.y / zoom;
        const worldW = viewport.clientWidth / zoom;
        const worldH = viewport.clientHeight / zoom;

        const vx = worldLeft * scale + ox;
        const vy = worldTop * scale + oy;
        const vw = worldW * scale;
        const vh = worldH * scale;

        ctx.strokeStyle = 'rgba(255,80,80,0.95)';
        ctx.lineWidth = 2;
        ctx.strokeRect(vx, vy, vw, vh);
    }

    private updateCorkboardConnections(): void {
        const svg = this.corkboardConnectionSvg;
        if (!svg) return;

        const viewport = this.boardEl?.querySelector('.story-line-corkboard-viewport') as HTMLElement | null;
        if (!viewport) return;

        const viewportRect = viewport.getBoundingClientRect();

        while (svg.firstChild) {
            svg.removeChild(svg.firstChild);
        }

        if (!this.corkboardConnectionsEnabled) return;

        const selectedNodes = Array.from(this.boardEl?.querySelectorAll<HTMLElement>('.story-line-corkboard-node') || [])
            .filter(node => this.selectedScenes.has(node.dataset.filePath || ''));

        if (selectedNodes.length < 2) return;

        const points = selectedNodes.map(node => {
            const rect = node.getBoundingClientRect();
            const x = rect.left + rect.width / 2 - viewportRect.left;
            const y = rect.top + rect.height / 2 - viewportRect.top;
            return `${x},${y}`;
        }).join(' ');

        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', points);
        polyline.setAttribute('stroke', 'rgba(255,255,255,0.6)');
        polyline.setAttribute('stroke-width', '2');
        polyline.setAttribute('fill', 'none');

        svg.appendChild(polyline);
    }

    /**
     * Animate zoom smoothly toward targetZoom over ~80ms.
     * Keeps the world point under the cursor stationary.
     */
    private zoomCorkboardAt(canvas: HTMLElement, viewport: HTMLElement, clientX: number, clientY: number, nextZoom: number): void {
        this.corkboardZoomTarget = Math.max(0.35, Math.min(2.8, nextZoom));
        const rect = viewport.getBoundingClientRect();
        this.corkboardZoomPivot.vx = clientX - rect.left;
        this.corkboardZoomPivot.vy = clientY - rect.top;

        // If an animation loop is already running it will pick up the
        // updated target — no need to restart it.
        if (this.corkboardZoomRaf !== null) return;

        const step = () => {
            const target = this.corkboardZoomTarget!;
            const cur = this.corkboardCamera.zoom;
            // Exponential lerp — converges smoothly regardless of how
            // many wheel ticks pile up.  0.25 gives a snappy yet fluid feel.
            const lerpFactor = 0.25;
            const newZoom = cur + (target - cur) * lerpFactor;

            // Keep the world point under the cursor stationary
            const { vx, vy } = this.corkboardZoomPivot;
            const worldX = (vx - this.corkboardCamera.x) / cur;
            const worldY = (vy - this.corkboardCamera.y) / cur;
            this.corkboardCamera.zoom = newZoom;
            this.corkboardCamera.x = vx - worldX * newZoom;
            this.corkboardCamera.y = vy - worldY * newZoom;
            this.applyCorkboardCamera(canvas);

            // Stop when close enough to the target
            if (Math.abs(newZoom - target) > 0.001) {
                this.corkboardZoomRaf = requestAnimationFrame(step);
            } else {
                // Snap to exact target on last frame
                const worldX2 = (vx - this.corkboardCamera.x) / newZoom;
                const worldY2 = (vy - this.corkboardCamera.y) / newZoom;
                this.corkboardCamera.zoom = target;
                this.corkboardCamera.x = vx - worldX2 * target;
                this.corkboardCamera.y = vy - worldY2 * target;
                this.applyCorkboardCamera(canvas);
                this.corkboardZoomRaf = null;
                this.corkboardZoomTarget = null;
            }
        };
        this.corkboardZoomRaf = requestAnimationFrame(step);
    }

    private enableCorkboardCameraInteraction(viewport: HTMLElement, canvas: HTMLElement): () => void {
        let isPanning = false;
        let panPointerId: number | null = null;
        let panStartX = 0;
        let panStartY = 0;
        let camStartX = 0;
        let camStartY = 0;

        const touchPoints = new Map<number, { x: number; y: number }>();
        let pinchPrevDistance = 0;
        let pinchPrevCenter: { x: number; y: number } | null = null;

        const isBackgroundTarget = (target: EventTarget | null): boolean => {
            const el = target as HTMLElement | null;
            if (!el) return true;
            return !el.closest('.story-line-corkboard-node, button, a, input, textarea, select');
        };

        const getTouchPair = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
            const vals = Array.from(touchPoints.values());
            if (vals.length < 2) return null;
            return [vals[0], vals[1]];
        };

        let isLassoSelecting = false;
        let lassoStartX = 0;
        let lassoStartY = 0;
        let lassoEl: HTMLElement | null = null;

        const clearLassoOverlay = (): void => {
            if (lassoEl) {
                lassoEl.remove();
                lassoEl = null;
            }
            isLassoSelecting = false;
        };

        const getViewportPoint = (clientX: number, clientY: number) => {
            const rect = viewport.getBoundingClientRect();
            return {
                x: clientX - rect.left,
                y: clientY - rect.top,
            };
        };

        const rectsIntersect = (a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }) => {
            return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
        };

        const updateLassoOverlay = (clientX: number, clientY: number): void => {
            if (!lassoEl) return;
            const point = getViewportPoint(clientX, clientY);
            const left = Math.min(lassoStartX, point.x);
            const top = Math.min(lassoStartY, point.y);
            const width = Math.abs(point.x - lassoStartX);
            const height = Math.abs(point.y - lassoStartY);
            lassoEl.style.left = `${left}px`;
            lassoEl.style.top = `${top}px`;
            lassoEl.style.width = `${width}px`;
            lassoEl.style.height = `${height}px`;
        };

        // Velocity tracking for subtle inertia
        let lastMoveTime = 0;
        let velocityX = 0;
        let velocityY = 0;
        const VELOCITY_DECAY = 0.88;   // how quickly inertia fades (lower = faster stop)
        const VELOCITY_THRESHOLD = 0.3; // stop when velocity is negligible

        const recordVelocity = (dx: number, dy: number) => {
            const now = performance.now();
            const dt = now - lastMoveTime;
            lastMoveTime = now;
            if (dt > 0 && dt < 100) {
                velocityX = dx / dt * 16; // normalize to ~16ms frame
                velocityY = dy / dt * 16;
            }
        };

        const startInertia = () => {
            if (Math.abs(velocityX) < VELOCITY_THRESHOLD && Math.abs(velocityY) < VELOCITY_THRESHOLD) return;
            const inertiaStep = () => {
                velocityX *= VELOCITY_DECAY;
                velocityY *= VELOCITY_DECAY;
                if (Math.abs(velocityX) < VELOCITY_THRESHOLD && Math.abs(velocityY) < VELOCITY_THRESHOLD) {
                    this.corkboardInertiaRaf = null;
                    return;
                }
                this.corkboardCamera.x += velocityX;
                this.corkboardCamera.y += velocityY;
                this.applyCorkboardCamera(canvas);
                this.corkboardInertiaRaf = requestAnimationFrame(inertiaStep);
            };
            this.corkboardInertiaRaf = requestAnimationFrame(inertiaStep);
        };

        const onPointerDown = (e: PointerEvent) => {
            if (!isBackgroundTarget(e.target)) return;

            // Stop any running inertia when user grabs the canvas
            if (this.corkboardInertiaRaf !== null) {
                cancelAnimationFrame(this.corkboardInertiaRaf);
                this.corkboardInertiaRaf = null;
            }
            velocityX = 0;
            velocityY = 0;
            lastMoveTime = performance.now();

            if (e.pointerType === 'touch') {
                touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });

                if (touchPoints.size === 1) {
                    isPanning = true;
                    panPointerId = e.pointerId;
                    panStartX = e.clientX;
                    panStartY = e.clientY;
                    camStartX = this.corkboardCamera.x;
                    camStartY = this.corkboardCamera.y;
                    viewport.classList.add('is-panning');
                } else if (touchPoints.size >= 2) {
                    isPanning = false;
                    panPointerId = null;
                    viewport.classList.remove('is-panning');
                    const pair = getTouchPair();
                    if (pair) {
                        const [a, b] = pair;
                        pinchPrevDistance = Math.hypot(b.x - a.x, b.y - a.y);
                        pinchPrevCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                    }
                }

                if (!viewport.hasPointerCapture(e.pointerId)) {
                    viewport.setPointerCapture(e.pointerId);
                }
                e.preventDefault();
                return;
            }

            const canPanMouse = e.button === 0 || e.button === 1;
            if (!canPanMouse) return;

            if (e.shiftKey && isBackgroundTarget(e.target)) {
                isLassoSelecting = true;
                const start = getViewportPoint(e.clientX, e.clientY);
                lassoStartX = start.x;
                lassoStartY = start.y;
                clearLassoOverlay();
                lassoEl = viewport.createDiv();
                lassoEl.style.position = 'absolute';
                lassoEl.style.pointerEvents = 'none';
                lassoEl.style.border = '1px dashed rgba(0, 122, 255, 0.9)';
                lassoEl.style.background = 'rgba(0, 122, 255, 0.14)';
                lassoEl.style.zIndex = '1000';
                lassoEl.style.left = `${lassoStartX}px`;
                lassoEl.style.top = `${lassoStartY}px`;
                lassoEl.style.width = '0px';
                lassoEl.style.height = '0px';
                viewport.setPointerCapture(e.pointerId);
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            isPanning = true;
            panPointerId = e.pointerId;
            panStartX = e.clientX;
            panStartY = e.clientY;
            camStartX = this.corkboardCamera.x;
            camStartY = this.corkboardCamera.y;
            viewport.classList.add('is-panning');

            viewport.setPointerCapture(e.pointerId);
            e.preventDefault();
        };

        const onPointerMove = (e: PointerEvent) => {
            if (e.pointerType === 'touch' && touchPoints.has(e.pointerId)) {
                touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }

            if (isLassoSelecting) {
                updateLassoOverlay(e.clientX, e.clientY);
                e.preventDefault();
                return;
            }

            if (touchPoints.size >= 2) {
                const pair = getTouchPair();
                if (!pair) return;
                const [a, b] = pair;
                const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const dist = Math.hypot(b.x - a.x, b.y - a.y);

                if (pinchPrevDistance > 0) {
                    const zoomFactor = dist / pinchPrevDistance;
                    this.zoomCorkboardAt(canvas, viewport, center.x, center.y, this.corkboardCamera.zoom * zoomFactor);
                }

                if (pinchPrevCenter) {
                    this.corkboardCamera.x += center.x - pinchPrevCenter.x;
                    this.corkboardCamera.y += center.y - pinchPrevCenter.y;
                    this.applyCorkboardCamera(canvas);
                }

                pinchPrevDistance = dist;
                pinchPrevCenter = center;
                e.preventDefault();
                return;
            }

            if (!isPanning || panPointerId !== e.pointerId) return;

            const dx = e.clientX - panStartX;
            const dy = e.clientY - panStartY;
            const prevCamX = this.corkboardCamera.x;
            const prevCamY = this.corkboardCamera.y;
            this.corkboardCamera.x = camStartX + dx;
            this.corkboardCamera.y = camStartY + dy;
            // Track velocity for inertia
            recordVelocity(this.corkboardCamera.x - prevCamX, this.corkboardCamera.y - prevCamY);
            this.applyCorkboardCamera(canvas);
            e.preventDefault();
        };

        const onPointerUp = (e: PointerEvent) => {
            if (isLassoSelecting) {
                const viewportRect = viewport.getBoundingClientRect();
                const current = getViewportPoint(e.clientX, e.clientY);
                const selectionRect = {
                    left: Math.min(lassoStartX, current.x),
                    top: Math.min(lassoStartY, current.y),
                    width: Math.abs(current.x - lassoStartX),
                    height: Math.abs(current.y - lassoStartY),
                };
                const selectionAbsRect = {
                    left: viewportRect.left + selectionRect.left,
                    top: viewportRect.top + selectionRect.top,
                    width: selectionRect.width,
                    height: selectionRect.height,
                };

                const matchedPaths = new Set<string>();
                const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.story-line-corkboard-node'));
                for (const node of nodes) {
                    const path = node.dataset.filePath;
                    if (!path) continue;
                    const nodeBounds = node.getBoundingClientRect();
                    const nodeRect = {
                        left: nodeBounds.left,
                        top: nodeBounds.top,
                        width: nodeBounds.width,
                        height: nodeBounds.height,
                    };
                    if (rectsIntersect(selectionAbsRect, nodeRect)) {
                        matchedPaths.add(path);
                    }
                }

                if (!e.ctrlKey && !e.metaKey) {
                    this.selectedScenes.clear();
                }
                for (const path of matchedPaths) {
                    this.selectedScenes.add(path);
                }
                if (matchedPaths.size > 0) {
                    const lastPath = Array.from(matchedPaths).pop()!;
                    const lastScene = this.sceneManager.getScene(lastPath);
                    if (lastScene) {
                        this.selectedScene = lastScene;
                    }
                }
                this.updateBulkBar();
                this.refreshBoard();
                clearLassoOverlay();
                if (viewport.hasPointerCapture(e.pointerId)) {
                    viewport.releasePointerCapture(e.pointerId);
                }
                return;
            }

            touchPoints.delete(e.pointerId);

            if (touchPoints.size < 2) {
                pinchPrevDistance = 0;
                pinchPrevCenter = null;
            }

            if (panPointerId === e.pointerId) {
                isPanning = false;
                panPointerId = null;
                viewport.classList.remove('is-panning');
                // Kick off subtle inertia
                startInertia();
            }

            if (viewport.hasPointerCapture(e.pointerId)) {
                viewport.releasePointerCapture(e.pointerId);
            }
        };

        const onWheel = (e: WheelEvent) => {
            const zoomFactor = Math.exp((-e.deltaY) * 0.0012);
            this.zoomCorkboardAt(canvas, viewport, e.clientX, e.clientY, this.corkboardCamera.zoom * zoomFactor);
            e.preventDefault();
        };

        viewport.addEventListener('pointerdown', onPointerDown);
        viewport.addEventListener('pointermove', onPointerMove);
        viewport.addEventListener('pointerup', onPointerUp);
        viewport.addEventListener('pointercancel', onPointerUp);
        viewport.addEventListener('wheel', onWheel, { passive: false });

        return () => {
            viewport.removeEventListener('pointerdown', onPointerDown);
            viewport.removeEventListener('pointermove', onPointerMove);
            viewport.removeEventListener('pointerup', onPointerUp);
            viewport.removeEventListener('pointercancel', onPointerUp);
            viewport.removeEventListener('wheel', onWheel as EventListener);
            viewport.classList.remove('is-panning');
            if (this.corkboardInertiaRaf !== null) {
                cancelAnimationFrame(this.corkboardInertiaRaf);
                this.corkboardInertiaRaf = null;
            }
            if (this.corkboardZoomRaf !== null) {
                cancelAnimationFrame(this.corkboardZoomRaf);
                this.corkboardZoomRaf = null;
            }
        };
    }

    private attachCorkboardLassoSelection(viewport: HTMLElement): void {
        let lassoEl: HTMLElement | null = null;
        let startX = 0;
        let startY = 0;

        const rectsIntersect = (a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }) => {
            return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
        };

        const cleanupLasso = (pointerId?: number) => {
            if (lassoEl) {
                lassoEl.remove();
                lassoEl = null;
            }
            viewport.removeEventListener('pointermove', onPointerMove);
            viewport.removeEventListener('pointerup', onPointerUp);
            viewport.removeEventListener('pointercancel', onPointerUp);
            if (typeof pointerId === 'number' && viewport.hasPointerCapture(pointerId)) {
                viewport.releasePointerCapture(pointerId);
            }
        };

        const onPointerMove = (event: PointerEvent) => {
            if (!lassoEl) return;
            const viewportRect = viewport.getBoundingClientRect();
            const x = event.clientX - viewportRect.left;
            const y = event.clientY - viewportRect.top;
            const left = Math.min(startX, x);
            const top = Math.min(startY, y);
            lassoEl.style.left = `${left}px`;
            lassoEl.style.top = `${top}px`;
            lassoEl.style.width = `${Math.abs(x - startX)}px`;
            lassoEl.style.height = `${Math.abs(y - startY)}px`;
            event.preventDefault();
            event.stopPropagation();
        };

        const onPointerUp = (event: PointerEvent) => {
            if (!lassoEl) return;
            const lassoRect = lassoEl.getBoundingClientRect();
            const nodes = Array.from(viewport.querySelectorAll<HTMLElement>('.story-line-corkboard-node'));
            if (!event.ctrlKey && !event.metaKey) {
                this.selectedScenes.clear();
            }
            for (const node of nodes) {
                const path = node.dataset.filePath;
                if (!path) continue;
                const nodeRect = node.getBoundingClientRect();
                if (rectsIntersect(lassoRect, nodeRect)) {
                    this.selectedScenes.add(path);
                }
            }
            this.updateBulkBar();
            this.refreshBoard();
            cleanupLasso(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
        };

        const onPointerDown = (event: PointerEvent) => {
            if (!event.shiftKey) return;
            const target = event.target as HTMLElement | null;
            if (!target) return;
            if (target.closest('.story-line-corkboard-node, button, a, input, textarea, select, .story-line-corkboard-note-card, .story-line-corkboard-note-resize-handle')) {
                return;
            }
            const viewportRect = viewport.getBoundingClientRect();
            startX = event.clientX - viewportRect.left;
            startY = event.clientY - viewportRect.top;
            cleanupLasso();
            lassoEl = viewport.createDiv('story-line-corkboard-lasso');
            lassoEl.style.position = 'absolute';
            lassoEl.style.pointerEvents = 'none';
            lassoEl.style.border = '1px solid var(--interactive-accent)';
            lassoEl.style.background = 'rgba(100, 150, 255, 0.15)';
            lassoEl.style.zIndex = '9999';
            lassoEl.style.left = `${startX}px`;
            lassoEl.style.top = `${startY}px`;
            lassoEl.style.width = '0px';
            lassoEl.style.height = '0px';
            viewport.addEventListener('pointermove', onPointerMove);
            viewport.addEventListener('pointerup', onPointerUp);
            viewport.addEventListener('pointercancel', onPointerUp);
            if (!viewport.hasPointerCapture(event.pointerId)) {
                viewport.setPointerCapture(event.pointerId);
            }
            event.preventDefault();
            event.stopPropagation();
        };

        viewport.addEventListener('pointerdown', onPointerDown, true);
    }

    /** Force BoardView to reload corkboard positions from SceneManager on next refresh. */
    invalidateCorkboardLayout(): void {
        this.corkboardLoadedProjectFile = '__invalidated__';
    }

    /** Flush any pending corkboard position writes to SceneManager immediately. */
    async flushPendingCorkboardPersist(): Promise<void> {
        if (this.corkboardPersistTimer) {
            clearTimeout(this.corkboardPersistTimer);
            this.corkboardPersistTimer = null;
            await this.persistCorkboardLayout();
        }
    }

    private ensureCorkboardLayoutLoaded(): void {
        const projectPath = this.sceneManager.activeProject?.filePath ?? null;
        if (projectPath === this.corkboardLoadedProjectFile) return;

        // Cancel pending persist from a prior render to prevent auto-layout
        // defaults from overwriting real positions loaded from board.json.
        if (this.corkboardPersistTimer) {
            clearTimeout(this.corkboardPersistTimer);
            this.corkboardPersistTimer = null;
        }

        this.corkboardLoadedProjectFile = projectPath;
        this.corkboardPositions.clear();
        this._corkboardProjectLoaded = !!projectPath;

        const saved = this.sceneManager.getCorkboardPositions();
        for (const [path, pos] of Object.entries(saved)) {
            const x = Number(pos?.x);
            const y = Number(pos?.y);
            const z = Number(pos?.z);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const h = Number(pos?.h);
            this.corkboardPositions.set(path, { x, y, z: Number.isFinite(z) ? z : 1, ...(Number.isFinite(h) && h > 0 ? { h } : {}) });
        }
    }

    private schedulePersistCorkboardLayout(): void {
        if (this.corkboardPersistTimer) {
            clearTimeout(this.corkboardPersistTimer);
        }
        this.corkboardPersistTimer = setTimeout(() => {
            this.corkboardPersistTimer = null;
            void this.persistCorkboardLayout();
        }, 500);
    }

    private async persistCorkboardLayout(): Promise<void> {
        const payload: Record<string, { x: number; y: number; z?: number; h?: number }> = {};
        for (const [path, pos] of this.corkboardPositions.entries()) {
            payload[path] = { x: pos.x, y: pos.y, z: pos.z, ...(pos.h ? { h: pos.h } : {}) };
        }
        await this.sceneManager.setCorkboardPositions(payload);
        this.plugin.viewSnapshotService.scheduleAutoSave();
    }

    private showCorkboardNoteMenu(scene: Scene, event: MouseEvent): void {
        const scenePath = scene.filePath;
        const menu = new Menu();

        menu.addItem(item => item
            .setTitle('Top')
            .setIcon('chevrons-up')
            .onClick(() => { this.moveCorkboardLayer(scenePath, 'top'); }));

        menu.addItem(item => item
            .setTitle('Up')
            .setIcon('arrow-up')
            .onClick(() => { this.moveCorkboardLayer(scenePath, 'up'); }));

        menu.addItem(item => item
            .setTitle('Down')
            .setIcon('arrow-down')
            .onClick(() => { this.moveCorkboardLayer(scenePath, 'down'); }));

        menu.addItem(item => item
            .setTitle('Bottom')
            .setIcon('chevrons-down')
            .onClick(() => { this.moveCorkboardLayer(scenePath, 'bottom'); }));

        menu.addSeparator();

        const notePresets = resolveStickyNoteColors(this.plugin.settings);
        notePresets.forEach((preset) => {
            menu.addItem(item => item
                .setTitle(`Color: ${preset.label}`)
                .setIcon('palette')
                .onClick(() => { void this.setCorkboardNoteColor(scene, preset.color); }));
        });

        menu.addItem(item => item
            .setTitle('Color: Custom…')
            .setIcon('pipette')
            .onClick(() => { this.openCorkboardNoteColorModal(scene); }));

        menu.addItem(item => item
            .setTitle('Color: Default')
            .setIcon('rotate-ccw')
            .onClick(() => { void this.setCorkboardNoteColor(scene, undefined); }));

        menu.addSeparator();
        menu.addItem(item => item
            .setTitle('Duplicate Note')
            .setIcon('copy')
            .onClick(() => { void this.duplicateCorkboardNote(scene); }));

        // Image note controls
        menu.addSeparator();
        if (scene.corkboardNoteImage) {
            menu.addItem(item => item
                .setTitle('Change Image…')
                .setIcon('image')
                .onClick(() => { void this.changeNoteImage(scene); }));
            menu.addItem(item => item
                .setTitle('Remove Image')
                .setIcon('image-off')
                .onClick(async () => {
                    await this.sceneManager.updateScene(scene.filePath, {
                        corkboardNoteImage: undefined,
                        corkboardNoteCaption: undefined,
                    });
                    scene.corkboardNoteImage = undefined;
                    scene.corkboardNoteCaption = undefined;
                    this.refreshBoard();
                }));
        } else {
            menu.addItem(item => item
                .setTitle('Set Image…')
                .setIcon('image-plus')
                .onClick(() => { void this.changeNoteImage(scene); }));
        }

        menu.addItem(item => item
            .setTitle('Delete Note')
            .setIcon('trash')
            .onClick(async () => {
                await this.deleteScene(scene);
            }));

        if (!scene.corkboardNoteImage) {
            menu.addSeparator();
            menu.addItem(item => item
                .setTitle('Convert to Scene')
                .setIcon('clapperboard')
                .onClick(() => { void this.convertCorkboardNoteToScene(scene); }));
        }

        menu.showAtMouseEvent(event);
    }

    private moveCorkboardLayer(scenePath: string, direction: 'top' | 'up' | 'down' | 'bottom'): void {
        const target = this.corkboardPositions.get(scenePath);
        if (!target) return;

        const entries = Array.from(this.corkboardPositions.entries());
        if (entries.length < 2) return;

        entries.sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0));
        const index = entries.findIndex(([path]) => path === scenePath);
        if (index < 0) return;

        if (direction === 'top' && index < entries.length - 1) {
            const [entry] = entries.splice(index, 1);
            entries.push(entry);
        } else if (direction === 'bottom' && index > 0) {
            const [entry] = entries.splice(index, 1);
            entries.unshift(entry);
        } else if (direction === 'up' && index < entries.length - 1) {
            const tmp = entries[index + 1];
            entries[index + 1] = entries[index];
            entries[index] = tmp;
        } else if (direction === 'down' && index > 0) {
            const tmp = entries[index - 1];
            entries[index - 1] = entries[index];
            entries[index] = tmp;
        } else {
            return;
        }

        let z = 1;
        for (const [path, pos] of entries) {
            this.corkboardPositions.set(path, { ...pos, z });
            z += 1;
        }

        this.schedulePersistCorkboardLayout();
        this.refreshBoard();
    }

    private normalizeHexColor(value: string | undefined): string | undefined {
        if (!value) return undefined;
        const trimmed = value.trim();

        const short = trimmed.match(/^#([0-9a-fA-F]{3})$/);
        if (short) {
            const [r, g, b] = short[1].split('');
            return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
        }

        const full = trimmed.match(/^#([0-9a-fA-F]{6})$/);
        if (full) return `#${full[1].toUpperCase()}`;

        return undefined;
    }

    private darkenHexColor(hex: string, factor: number): string {
        const normalized = this.normalizeHexColor(hex) ?? '#F6EDB4';
        const r = Number.parseInt(normalized.slice(1, 3), 16);
        const g = Number.parseInt(normalized.slice(3, 5), 16);
        const b = Number.parseInt(normalized.slice(5, 7), 16);

        const scale = Math.max(0, Math.min(1, 1 - factor));
        const nr = Math.round(r * scale);
        const ng = Math.round(g * scale);
        const nb = Math.round(b * scale);

        const toHex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
        return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
    }

    private hexToRgba(hex: string, alpha: number): string {
        const normalized = this.normalizeHexColor(hex) ?? '#9A9072';
        const r = Number.parseInt(normalized.slice(1, 3), 16);
        const g = Number.parseInt(normalized.slice(3, 5), 16);
        const b = Number.parseInt(normalized.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
    }

    private applyCorkboardNoteColor(cardEl: HTMLElement, scene: Scene): void {
        const presets = resolveStickyNoteColors(this.plugin.settings);
        const defaultColor = presets.length > 0 ? presets[0].color : '#F6EDB4';
        const base = this.normalizeHexColor(scene.corkboardNoteColor) ?? defaultColor;
        const accentSoft = this.darkenHexColor(base, 0.24);
        const accentStrong = this.darkenHexColor(base, 0.34);
        cardEl.style.setProperty('--sl-note-bg', base);
        cardEl.style.setProperty('--sl-note-accent', accentSoft);
        cardEl.style.setProperty('--sl-note-accent-strong', accentStrong);
    }

    private async setCorkboardNoteColor(scene: Scene, color: string | undefined): Promise<void> {
        const normalized = this.normalizeHexColor(color);
        await this.sceneManager.updateScene(scene.filePath, {
            corkboardNoteColor: normalized,
        });
        scene.corkboardNoteColor = normalized;

        const card = this.boardEl?.querySelector(`[data-path="${CSS.escape(scene.filePath)}"]`) as HTMLElement | null;
        if (card) {
            this.applyCorkboardNoteColor(card, scene);
        }
    }

    private openCorkboardNoteColorModal(scene: Scene): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText('Custom note color');

        const current = this.normalizeHexColor(scene.corkboardNoteColor) ?? '#F6EDB4';
        const row = modal.contentEl.createDiv('story-line-note-color-modal-row');
        row.createEl('label', { text: 'Pick color' });
        const picker = row.createEl('input', {
            attr: {
                type: 'color',
                value: current,
            },
        });

        new Setting(modal.contentEl)
            .addButton(btn => {
                btn.setButtonText('Cancel').onClick(() => modal.close());
            })
            .addButton(btn => {
                btn.setButtonText('Apply').setCta().onClick(async () => {
                    await this.setCorkboardNoteColor(scene, picker.value);
                    modal.close();
                });
            });

        modal.open();
    }

    /**
     * Render a single board column
     */
    private renderColumn(board: HTMLElement, title: string, scenes: Scene[]): void {
        const column = board.createDiv('story-line-column');
        column.setAttribute('data-group', title);

        // Column header
        const header = column.createDiv('story-line-column-header');

        // Build display title with label if available
        const displayTitle = this.getColumnDisplayTitle(title);
        header.createSpan({
            cls: 'story-line-column-title',
            text: `${displayTitle} (${scenes.length})`
        });

        // Show description subtitle if available (for act / chapter columns)
        const columnDesc = this.getColumnDescription(title);
        if (columnDesc) {
            header.createDiv({
                cls: 'story-line-column-description',
                text: columnDesc,
            });
        }

        // Right-click context menu on column header
        if (this.groupBy === 'act' || this.groupBy === 'chapter') {
            header.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showColumnContextMenu(e, title, scenes);
            });
        }

        // Column body (scrollable)
        const body = column.createDiv('story-line-column-body');

        // Helper: render a single scene card with drag-drop handlers
        const renderSceneCard = (scene: Scene, _index: number, parent: HTMLElement): HTMLElement => {
            const cardEl = this.cardComponent.render(scene, parent, {
                compact: this.plugin.settings.compactCardView,
                onSelect: (s, event) => {
                    this.selectScene(s, event);
                },
                onDoubleClick: (s) => this.openScene(s),
                onContextMenu: (s, event) => this.showContextMenu(s, event),
                draggable: true,
            });

            // --- Per-card drop zone for reordering within a column ---
            cardEl.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = cardEl.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                cardEl.removeClass('drop-above', 'drop-below');
                if (e.clientY < midY) {
                    cardEl.addClass('drop-above');
                } else {
                    cardEl.addClass('drop-below');
                }
            });
            cardEl.addEventListener('dragleave', () => {
                cardEl.removeClass('drop-above', 'drop-below');
            });
            cardEl.addEventListener('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                cardEl.removeClass('drop-above', 'drop-below');
                body.removeClass('drag-over');
                const filePath = e.dataTransfer?.getData('text/scene-path');
                if (!filePath || filePath === scene.filePath) return;

                const rect = cardEl.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const insertBefore = e.clientY < midY;

                await this.handleDropOnCard(filePath, scene, title, scenes, insertBefore);
            });

            // Mobile: touch-based drag-and-drop
            if (isMobile) {
                enableTouchDrag(cardEl, scene.filePath, async (targetEl, insertBefore) => {
                    const targetPath = targetEl.getAttribute('data-path');
                    if (!targetPath || targetPath === scene.filePath) return;
                    const targetScene = this.sceneManager.getScene(targetPath);
                    if (!targetScene) return;

                    // Resolve the *target* column (may differ from source)
                    const targetColumn = targetEl.closest('.story-line-column');
                    const targetGroupKey = targetColumn?.getAttribute('data-group') || title;
                    const groups = this.sceneManager.getScenesGroupedByWithEmpty(
                        this.groupBy, this.currentFilter, this.currentSort
                    );
                    const targetScenes = groups.get(targetGroupKey) || scenes;

                    await this.handleDropOnCard(scene.filePath, targetScene, targetGroupKey, targetScenes, insertBefore);
                });
            }

            return cardEl;
        };

        // Use VirtualScroller for large columns to avoid DOM bloat
        const scroller = new VirtualScroller<Scene>({
            container: body,
            itemHeight: this.plugin.settings.compactCardView ? 60 : (isMobile ? 140 : 110),
            items: scenes,
            renderItem: renderSceneCard,
            overscan: 5,
            threshold: 40,
        });
        scroller.mount();
        this.scrollers.push(scroller);

        // Column-level drop zone (for empty columns or drop at end)
        body.addEventListener('dragover', (e) => {
            e.preventDefault();
            body.addClass('drag-over');
        });
        body.addEventListener('dragleave', (e) => {
            // Only remove if actually leaving the body
            if (!body.contains(e.relatedTarget as Node)) {
                body.removeClass('drag-over');
            }
        });
        body.addEventListener('drop', async (e) => {
            e.preventDefault();
            body.removeClass('drag-over');
            const filePath = e.dataTransfer?.getData('text/scene-path');
            if (filePath) {
                await this.handleDrop(filePath, title, scenes);
            }
        });

        // Add scene button at bottom
        const addBtn = column.createEl('button', {
            cls: 'story-line-column-add',
            text: '+ Add Scene'
        });
        addBtn.addEventListener('click', () => this.openQuickAdd(title));
    }

    /**
     * Handle dropping a card onto another card for precise reordering.
     *
     * Uses the same approach as TimelineView: splice the dragged scene into the
     * new visual position, then renumber sequences within each (act, chapter)
     * group so the displayed order matches.
     */
    private async handleDropOnCard(
        draggedPath: string,
        targetScene: Scene,
        columnTitle: string,
        columnScenes: Scene[],
        insertBefore: boolean
    ): Promise<void> {
        const updates: Partial<Scene> = {};

        // Assign group value (act/chapter/status/pov) based on column
        switch (this.groupBy) {
            case 'act': {
                // Allow non-numeric acts like "1.1" or "Prologue" through
                // parseActChapterInput, which keeps integers as numbers and
                // anything else as a trimmed string.
                const match = columnTitle.match(/^Act\s+(.+)$/);
                if (match) updates.act = parseActChapterInput(match[1]);
                break;
            }
            case 'chapter': {
                const match = columnTitle.match(/^Chapter\s+(.+)$/);
                if (match) updates.chapter = parseActChapterInput(match[1]);
                break;
            }
            case 'status': {
                const cfg = getStatusConfig();
                const statusId = Object.entries(cfg).find(([, v]) => v.label === columnTitle)?.[0] || columnTitle.toLowerCase();
                updates.status = statusId as SceneStatus;
                break;
            }
            case 'pov':
                updates.pov = columnTitle !== 'No POV' ? columnTitle : undefined;
                break;
        }

        // Build the visual order (same multi-key sort the display uses)
        const ordered = [...columnScenes].sort((a, b) => {
            const actCmp = compareActChapter(a.act, b.act);
            if (actCmp !== 0) return actCmp;
            const chCmp = compareActChapter(a.chapter, b.chapter);
            if (chCmp !== 0) return chCmp;
            return (a.sequence ?? 0) - (b.sequence ?? 0);
        });

        // Remove dragged scene from list
        const dragIdx = ordered.findIndex(s => s.filePath === draggedPath);
        if (dragIdx >= 0) ordered.splice(dragIdx, 1);

        // Find target position and insert
        const targetIdx = ordered.findIndex(s => s.filePath === targetScene.filePath);
        const insertIdx = targetIdx === -1
            ? ordered.length
            : insertBefore ? targetIdx : targetIdx + 1;

        const draggedScene = columnScenes.find(s => s.filePath === draggedPath);
        if (draggedScene) ordered.splice(insertIdx, 0, draggedScene);

        // When grouped by act, adopt the chapter from the nearest neighbor
        // so the card actually lands where the user dropped it.
        if (this.groupBy === 'act' && draggedScene) {
            const newIdx = ordered.indexOf(draggedScene);
            let neighborChapter: number | string | undefined;
            if (newIdx > 0) {
                neighborChapter = ordered[newIdx - 1].chapter;
            } else if (newIdx < ordered.length - 1) {
                neighborChapter = ordered[newIdx + 1].chapter;
            }
            if (neighborChapter !== undefined) {
                // Preserve the neighbor's chapter type — keeping a string
                // value like "1.1" intact instead of forcing it through Number().
                updates.chapter = neighborChapter;
            }
        }

        // Renumber sequences within each (act, chapter) group.
        // Group key uses String() so non-numeric values ("1.1", "Prologue")
        // still group cleanly and don't all collapse onto NaN.
        let prevKey = '\0';
        let seqInGroup = 0;
        for (const scene of ordered) {
            const key = `${String(scene.act ?? '')}\u0001${String(scene.chapter ?? '')}`;
            if (key !== prevKey) {
                seqInGroup = 0; prevKey = key;
            }
            seqInGroup++;
            const sceneUpdates: Partial<Scene> = { sequence: seqInGroup };
            if (scene.filePath === draggedPath) {
                Object.assign(sceneUpdates, updates);
            }
            await this.sceneManager.updateScene(scene.filePath, sceneUpdates);
        }

        this.plugin.viewSnapshotService.scheduleAutoSave();
        this.refreshBoard();
    }

    /**
     * Handle drag-and-drop of a scene to a new column
     */
    private async handleDrop(filePath: string, columnTitle: string, columnScenes: Scene[]): Promise<void> {
        const updates: Partial<Scene> = {};

        // Parse column title to extract value
        switch (this.groupBy) {
            case 'act': {
                const match = columnTitle.match(/^Act\s+(.+)$/);
                if (match) updates.act = parseActChapterInput(match[1]);
                break;
            }
            case 'chapter': {
                const match = columnTitle.match(/^Chapter\s+(.+)$/);
                if (match) updates.chapter = parseActChapterInput(match[1]);
                break;
            }
            case 'status': {
                const cfg = getStatusConfig();
                const statusId = Object.entries(cfg).find(([, v]) => v.label === columnTitle)?.[0] || columnTitle.toLowerCase();
                updates.status = statusId as SceneStatus;
                break;
            }
            case 'pov': {
                updates.pov = columnTitle !== 'No POV' ? columnTitle : undefined;
                break;
            }
        }

        // Build visual order and append dragged scene at the end
        const ordered = [...columnScenes].sort((a, b) => {
            const actCmp = compareActChapter(a.act, b.act);
            if (actCmp !== 0) return actCmp;
            const chCmp = compareActChapter(a.chapter, b.chapter);
            if (chCmp !== 0) return chCmp;
            return (a.sequence ?? 0) - (b.sequence ?? 0);
        });

        // When grouped by act, adopt chapter from last scene in column
        if (this.groupBy === 'act' && ordered.length > 0) {
            const last = ordered[ordered.length - 1];
            // Preserve the chapter's original type (don't coerce "1.1" to a float).
            if (last.chapter !== undefined) updates.chapter = last.chapter;
        }

        // Compute sequence at end of the last (act, chapter) group
        const maxSeq = columnScenes.reduce(
            (max, s) => Math.max(max, s.sequence ?? 0),
            0
        );
        updates.sequence = maxSeq + 1;

        await this.sceneManager.updateScene(filePath, updates);
        this.plugin.viewSnapshotService.scheduleAutoSave();
        this.refreshBoard();
    }

    /**
     * Select a scene (show in inspector). Ctrl/Cmd+click for multi-select.
     */
    private selectScene(scene: Scene, event?: MouseEvent): void {
        const isMultiSelect = event && (event.ctrlKey || event.metaKey);

        if (isMultiSelect) {
            // Toggle this scene in multi-selection
            if (this.selectedScenes.has(scene.filePath)) {
                this.selectedScenes.delete(scene.filePath);
                const card = this.boardEl?.querySelector(`[data-path="${CSS.escape(scene.filePath)}"]`);
                if (card) card.removeClass('selected');
            } else {
                this.selectedScenes.add(scene.filePath);
                const card = this.boardEl?.querySelector(`[data-path="${CSS.escape(scene.filePath)}"]`);
                if (card) card.addClass('selected');
            }
            this.selectedScene = scene;
        } else {
            // Single select — clear multi-selection
            this.selectedScenes.clear();
            this.boardEl?.querySelectorAll('.scene-card.selected').forEach(el => {
                el.removeClass('selected');
            });

            this.selectedScene = scene;
            this.selectedScenes.add(scene.filePath);

            // Highlight selected card
            const card = this.boardEl?.querySelector(`[data-path="${CSS.escape(scene.filePath)}"]`);
            if (card) card.addClass('selected');
        }

        // Show inspector for last clicked scene
        if (this.plugin.isSceneInspectorOpen()) {
            this.inspectorComponent?.hide();
            this.app.workspace.trigger('storyline:scene-focus', scene.filePath);
        } else {
            this.inspectorComponent?.show(scene);
        }

        // Update corkboard connections when selection changes
        if (this.boardMode === 'corkboard') {
            this.updateCorkboardConnections();
        }

        // Show/hide bulk action bar
        this.updateBulkBar();
    }

    /**
     * Update the bulk action bar based on current selection
     */
    private updateBulkBar(): void {
        if (!this.bulkBarEl) return;

        if (this.selectedScenes.size < 2) {
            this.bulkBarEl.style.display = 'none';
            if (this.corkboardAlignControlsEl) {
                this.corkboardAlignControlsEl.style.display = 'none';
            }
            return;
        }

        this.bulkBarEl.empty();
        this.bulkBarEl.style.display = 'flex';
        this.updateCorkboardAlignControls();

        const count = this.selectedScenes.size;
        this.bulkBarEl.createSpan({
            cls: 'bulk-bar-label',
            text: `${count} scenes selected`
        });

        // Bulk status change
        const statusBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn',
            text: 'Set Status'
        });
        const statusIcon = statusBtn.createSpan();
        obsidian.setIcon(statusIcon, 'check-circle');
        statusBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            const statuses = getStatusOrder();
            statuses.forEach(status => {
                menu.addItem(item => {
                    item.setTitle(resolveStatusCfg(status).label)
                        .onClick(async () => {
                            for (const fp of this.selectedScenes) {
                                await this.sceneManager.updateScene(fp, { status });
                            }
                            new Notice(`Updated status to "${status}" for ${count} scenes`);
                            this.selectedScenes.clear();
                            this.refreshBoard();
                            this.updateBulkBar();
                        });
                });
            });
            menu.showAtMouseEvent(e);
        });

        // Bulk move to act
        const actBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn',
            text: 'Move to Act'
        });
        const actIcon = actBtn.createSpan();
        obsidian.setIcon(actIcon, 'folder');
        actBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            const acts = this.sceneManager.getDefinedActs();
            if (acts.length === 0) {
                // Fallback: use acts found in scenes
                const actValues = this.sceneManager.getUniqueValues('act');
                actValues.forEach(act => {
                    menu.addItem(item => {
                        item.setTitle(`Act ${act}`)
                            .onClick(async () => {
                                for (const fp of this.selectedScenes) {
                                    await this.sceneManager.updateScene(fp, { act: Number(act) || act });
                                }
                                new Notice(`Moved ${count} scenes to Act ${act}`);
                                this.selectedScenes.clear();
                                this.refreshBoard();
                                this.updateBulkBar();
                            });
                    });
                });
            } else {
                acts.forEach(act => {
                    menu.addItem(item => {
                        item.setTitle(`Act ${act}`)
                            .onClick(async () => {
                                for (const fp of this.selectedScenes) {
                                    await this.sceneManager.updateScene(fp, { act });
                                }
                                new Notice(`Moved ${count} scenes to Act ${act}`);
                                this.selectedScenes.clear();
                                this.refreshBoard();
                                this.updateBulkBar();
                            });
                    });
                });
            }
            menu.showAtMouseEvent(e);
        });

        // Bulk add tag
        const tagBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn',
            text: 'Add Tag'
        });
        const tagIcon = tagBtn.createSpan();
        obsidian.setIcon(tagIcon, 'tag');
        tagBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            const tags = this.sceneManager.getAllTags();

            tags.forEach(tag => {
                menu.addItem(item => {
                    item.setTitle(tag)
                        .onClick(async () => {
                            for (const fp of this.selectedScenes) {
                                const scene = this.sceneManager.getScene(fp);
                                if (scene) {
                                    const newTags = [...(scene.tags || [])];
                                    if (!newTags.includes(tag)) {
                                        newTags.push(tag);
                                        await this.sceneManager.updateScene(fp, { tags: newTags } as any);
                                    }
                                }
                            }
                            new Notice(`Added tag "${tag}" to ${count} scenes`);
                            this.selectedScenes.clear();
                            this.refreshBoard();
                            this.updateBulkBar();
                        });
                });
            });

            // Option to enter a new tag
            menu.addSeparator();
            menu.addItem(item => {
                item.setTitle('New tag…')
                    .setIcon('plus')
                    .onClick(() => {
                        const newTag = prompt('Enter new tag:');
                        if (newTag) {
                            (async () => {
                                for (const fp of this.selectedScenes) {
                                    const scene = this.sceneManager.getScene(fp);
                                    if (scene) {
                                        const tags = [...(scene.tags || [])];
                                        if (!tags.includes(newTag)) {
                                            tags.push(newTag);
                                            await this.sceneManager.updateScene(fp, { tags } as any);
                                        }
                                    }
                                }
                                new Notice(`Added tag "${newTag}" to ${count} scenes`);
                                this.selectedScenes.clear();
                                this.refreshBoard();
                                this.updateBulkBar();
                            })();
                        }
                    });
            });

            menu.showAtMouseEvent(e);
        });

        // Bulk delete
        const deleteBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn bulk-bar-delete',
            text: 'Delete'
        });
        const deleteIcon = deleteBtn.createSpan();
        obsidian.setIcon(deleteIcon, 'trash');
        deleteBtn.addEventListener('click', async () => {
            openConfirmModal(this.app, {
                title: 'Delete Scenes',
                message: `Delete ${count} scene(s)? This cannot be undone.`,
                confirmLabel: 'Delete',
                onConfirm: async () => {
                    for (const fp of this.selectedScenes) {
                        await this.sceneManager.deleteScene(fp);
                    }
                    new Notice(`Deleted ${count} scenes`);
                    this.selectedScenes.clear();
                    this.refreshBoard();
                    this.updateBulkBar();
                },
            });
        });

        // Clear selection
        const clearBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn bulk-bar-clear',
            text: '× Clear'
        });
        clearBtn.addEventListener('click', () => {
            this.selectedScenes.clear();
            this.boardEl?.querySelectorAll('.scene-card.selected').forEach(el => {
                el.removeClass('selected');
            });
            this.updateBulkBar();
        });

        // Merge scenes (2+ selected)
        const mergeBtn = this.bulkBarEl.createEl('button', {
            cls: 'bulk-bar-btn',
            text: 'Merge'
        });
        const mergeIcon = mergeBtn.createSpan();
        obsidian.setIcon(mergeIcon, 'combine');
        mergeBtn.addEventListener('click', () => {
            // Collect selected scenes in sequence order
            const scenes = Array.from(this.selectedScenes)
                .map(fp => this.sceneManager.getScene(fp))
                .filter(Boolean) as Scene[];
            scenes.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

            if (scenes.length < 2) {
                new Notice('Select at least 2 scenes to merge');
                return;
            }

            new MergeSceneModal(this.plugin, scenes, () => {
                this.selectedScenes.clear();
                this.refreshBoard();
                this.updateBulkBar();
            }).open();
        });
    }

    /**
     * Open a scene in the editor
     */
    private async openScene(scene: Scene): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(scene.filePath);
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(file, { state: { mode: 'source', source: false } });
        } else {
            new Notice(`Could not find file: ${scene.filePath}`);
        }
    }

    /**
     * Delete a scene
     */
    private async deleteScene(scene: Scene): Promise<void> {
        await this.sceneManager.deleteScene(scene.filePath);
        this.refreshBoard();
    }

    /**
     * Show context menu for a scene
     */
    private showContextMenu(scene: Scene, event: MouseEvent): void {
        const menu = new Menu();

        if (this.boardMode === 'corkboard') {
            menu.addItem(item => item
                .setTitle('Top')
                .setIcon('chevrons-up')
                .onClick(() => { this.moveCorkboardLayer(scene.filePath, 'top'); }));

            menu.addItem(item => item
                .setTitle('Up')
                .setIcon('arrow-up')
                .onClick(() => { this.moveCorkboardLayer(scene.filePath, 'up'); }));

            menu.addItem(item => item
                .setTitle('Down')
                .setIcon('arrow-down')
                .onClick(() => { this.moveCorkboardLayer(scene.filePath, 'down'); }));

            menu.addItem(item => item
                .setTitle('Bottom')
                .setIcon('chevrons-down')
                .onClick(() => { this.moveCorkboardLayer(scene.filePath, 'bottom'); }));

            menu.addSeparator();
        }

        menu.addItem(item => {
            item.setTitle('Edit Scene')
                .setIcon('pencil')
                .onClick(() => this.openScene(scene));
        });

        menu.addItem(item => {
            item.setTitle('Duplicate Scene')
                .setIcon('copy')
                .onClick(async () => {
                    await this.sceneManager.duplicateScene(scene.filePath);
                    this.refreshBoard();
                });
        });

        menu.addItem(item => {
            item.setTitle('Split Scene')
                .setIcon('scissors')
                .onClick(() => {
                    new SplitSceneModal(this.plugin, scene, () => this.refreshBoard()).open();
                });
        });

        // Scene color picker
        menu.addItem(item => {
            item.setTitle(scene.color ? 'Change Color' : 'Set Color')
                .setIcon('palette')
                .onClick(() => {
                    SceneCardComponent.openColorPicker(this.app, scene, this.sceneManager, () => this.refreshBoard());
                });
        });

        menu.addSeparator();

        // Status submenu
        const statuses = getStatusOrder();
        statuses.forEach(status => {
            menu.addItem(item => {
                item.setTitle(`Status: ${resolveStatusCfg(status).label}`)
                    .setChecked(scene.status === status)
                    .onClick(async () => {
                        await this.sceneManager.updateScene(scene.filePath, { status });
                        this.refreshBoard();
                    });
            });
        });

        menu.addSeparator();

        // Move to Act submenu
        const definedActs = this.sceneManager.getDefinedActs();
        if (definedActs.length > 0) {
            menu.addItem(item => {
                item.setTitle('Move to Act…')
                    .setIcon('folder');
                // Build submenu manually via Menu
            });
            for (const act of definedActs) {
                menu.addItem(item => {
                    const rawActLabel = this.sceneManager.getActLabel(act);
                    const actLabel = rawActLabel?.replace(/^Act\s*\d+\s*[—:]\s*/i, '');
                    const display = actLabel ? `Act ${act} — ${actLabel}` : `Act ${act}`;
                    item.setTitle(display)
                        .setChecked(scene.act === act)
                        .onClick(async () => {
                            await this.sceneManager.updateScene(scene.filePath, { act });
                            this.refreshBoard();
                        });
                });
            }
        }

        // Move to Chapter submenu
        const definedChapters = this.sceneManager.getDefinedChapters();
        if (definedChapters.length > 0) {
            menu.addSeparator();
            for (const ch of definedChapters) {
                menu.addItem(item => {
                    const rawChLabel = this.sceneManager.getChapterLabel(ch);
                    const chLabel = rawChLabel?.replace(/^Ch(?:apter)?\s*\d+\s*[—:]\s*/i, '');
                    const display = chLabel ? `Ch ${ch} — ${chLabel}` : `Chapter ${ch}`;
                    item.setTitle(display)
                        .setChecked(scene.chapter === ch)
                        .onClick(async () => {
                            await this.sceneManager.updateScene(scene.filePath, { chapter: ch });
                            this.refreshBoard();
                        });
                });
            }
        }

        menu.addSeparator();

        menu.addItem(item => {
            item.setTitle('Save as Template')
                .setIcon('file-plus')
                .onClick(() => {
                    const tpl: SceneTemplate = {
                        name: `Template from "${scene.title || 'Untitled'}"`,
                        description: `Saved from scene "${scene.title || 'Untitled'}"`,
                        defaultFields: {
                            status: scene.status,
                            emotion: scene.emotion,
                            tags: scene.tags?.length ? [...scene.tags] : undefined,
                            conflict: scene.conflict,
                            target_wordcount: scene.target_wordcount,
                        },
                        bodyTemplate: scene.body || '',
                    };
                    this.plugin.settings.sceneTemplates.push(tpl);
                    this.plugin.saveSettings();
                    new Notice(`Scene template "${tpl.name}" saved`);
                });
        });

        menu.addSeparator();

        menu.addItem(item => {
            item.setTitle('Archive Scene')
                .setIcon('archive')
                .onClick(async () => {
                    await this.sceneManager.archiveScene(scene.filePath);
                    this.refreshBoard();
                });
        });

        menu.addItem(item => {
            item.setTitle('Delete Scene')
                .setIcon('trash')
                .onClick(async () => {
                    openConfirmModal(this.app, {
                        title: 'Delete Scene',
                        message: `Delete scene "${scene.title || 'Untitled'}"?`,
                        confirmLabel: 'Delete',
                        onConfirm: () => this.deleteScene(scene),
                    });
                });
        });

        menu.showAtMouseEvent(event);
    }

    /**
     * Open a modal listing archived scenes with restore buttons.
     */
    private async openArchiveModal(): Promise<void> {
        const modal = new Modal(this.app);
        modal.titleEl.setText('Archived Scenes');

        const archived = await this.sceneManager.getArchivedScenes();
        if (archived.length === 0) {
            modal.contentEl.createEl('p', { text: 'No archived scenes.', cls: 'setting-item-description' });
        } else {
            for (const item of archived) {
                const row = modal.contentEl.createDiv();
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.justifyContent = 'space-between';
                row.style.padding = '6px 0';
                row.style.borderBottom = '1px solid var(--background-modifier-border)';
                row.createSpan({ text: item.title });
                const restoreBtn = row.createEl('button', { text: 'Restore', cls: 'mod-cta' });
                restoreBtn.style.fontSize = '11px';
                restoreBtn.style.padding = '2px 10px';
                restoreBtn.addEventListener('click', async () => {
                    await this.sceneManager.restoreScene(item.filePath);
                    await this.sceneManager.initialize();
                    this.refreshBoard();
                    row.remove();
                    // Check if list is now empty
                    if (modal.contentEl.querySelectorAll('div').length === 0) {
                        modal.contentEl.empty();
                        modal.contentEl.createEl('p', { text: 'No archived scenes.', cls: 'setting-item-description' });
                    }
                    new Notice('Scene restored');
                });
            }
        }

        modal.open();
    }

    /**
     * Build a display title for a column header, including labels if available.
     */
    private getColumnDisplayTitle(groupKey: string): string {
        // Parse "Act N" or "Chapter N"
        const actMatch = groupKey.match(/^Act\s+(\d+)$/);
        if (actMatch) {
            const actNum = parseInt(actMatch[1], 10);
            const label = this.sceneManager.getActLabel(actNum);
            return label ? label : groupKey;
        }
        const chMatch = groupKey.match(/^Chapter\s+(\d+)$/);
        if (chMatch) {
            const chNum = parseInt(chMatch[1], 10);
            const label = this.sceneManager.getChapterLabel(chNum);
            return label ? label : groupKey;
        }
        return groupKey;
    }

    /**
     * Get a description for a column header (act or chapter), if one has been set.
     */
    private getColumnDescription(groupKey: string): string | undefined {
        const actMatch = groupKey.match(/^Act\s+(\d+)$/);
        if (actMatch) {
            return this.sceneManager.getActDescription(parseInt(actMatch[1], 10));
        }
        const chMatch = groupKey.match(/^Chapter\s+(\d+)$/);
        if (chMatch) {
            return this.sceneManager.getChapterDescription(parseInt(chMatch[1], 10));
        }
        return undefined;
    }

    /**
     * Show context menu on a column header (right-click).
     * Allows deleting/renaming acts or chapters.
     */
    private showColumnContextMenu(event: MouseEvent, groupKey: string, scenes: Scene[]): void {
        const menu = new Menu();
        const actMatch = groupKey.match(/^Act\s+(\d+)$/);
        const chMatch = groupKey.match(/^Chapter\s+(\d+)$/);

        if (actMatch) {
            const actNum = parseInt(actMatch[1], 10);
            const currentLabel = this.sceneManager.getActLabel(actNum) || '';

            menu.addItem(item => {
                item.setTitle('Rename Act')
                    .setIcon('pencil')
                    .onClick(() => {
                        this.openRenameModal('Act', actNum, currentLabel, async (newLabel) => {
                            await this.sceneManager.setActLabel(actNum, newLabel);
                            this.refreshBoard();
                        });
                    });
            });

            menu.addItem(item => {
                item.setTitle('Edit Description')
                    .setIcon('file-text')
                    .onClick(() => {
                        const currentDesc = this.sceneManager.getActDescription(actNum) || '';
                        this.openDescriptionModal('Act', actNum, currentDesc, async (desc) => {
                            await this.sceneManager.setActDescription(actNum, desc);
                            this.refreshBoard();
                        });
                    });
            });

            menu.addItem(item => {
                item.setTitle('Delete Act')
                    .setIcon('trash')
                    .onClick(() => {
                        if (scenes.length > 0) {
                            openConfirmModal(this.app, {
                                title: 'Delete Act',
                                message: `Act ${actNum} contains ${scenes.length} scene(s). Deleting the act removes the column but keeps the scenes (they'll become unassigned). Continue?`,
                                onConfirm: async () => {
                                    // Unassign scenes from this act
                                    for (const s of scenes) {
                                        await this.sceneManager.updateScene(s.filePath, { act: undefined });
                                    }
                                    await this.sceneManager.removeAct(actNum);
                                    await this.sceneManager.setActLabel(actNum, '');
                                    this.refreshBoard();
                                    new Notice(`Deleted Act ${actNum}`);
                                },
                            });
                        } else {
                            this.sceneManager.removeAct(actNum).then(() => {
                                this.sceneManager.setActLabel(actNum, '').then(() => {
                                    this.refreshBoard();
                                    new Notice(`Deleted Act ${actNum}`);
                                });
                            });
                        }
                    });
            });

            // Add existing scenes to this act
            menu.addSeparator();
            menu.addItem(item => {
                item.setTitle('Add existing scenes…')
                    .setIcon('plus-circle')
                    .onClick(() => {
                        this.openAssignScenesModal('act', actNum);
                    });
            });
        } else if (chMatch) {
            const chNum = parseInt(chMatch[1], 10);
            const currentLabel = this.sceneManager.getChapterLabel(chNum) || '';

            menu.addItem(item => {
                item.setTitle('Rename Chapter')
                    .setIcon('pencil')
                    .onClick(() => {
                        this.openRenameModal('Chapter', chNum, currentLabel, async (newLabel) => {
                            await this.sceneManager.setChapterLabel(chNum, newLabel);
                            this.refreshBoard();
                        });
                    });
            });

            menu.addItem(item => {
                item.setTitle('Edit Description')
                    .setIcon('file-text')
                    .onClick(() => {
                        const currentDesc = this.sceneManager.getChapterDescription(chNum) || '';
                        this.openDescriptionModal('Chapter', chNum, currentDesc, async (desc) => {
                            await this.sceneManager.setChapterDescription(chNum, desc);
                            this.refreshBoard();
                        });
                    });
            });

            menu.addItem(item => {
                item.setTitle('Delete Chapter')
                    .setIcon('trash')
                    .onClick(() => {
                        if (scenes.length > 0) {
                            openConfirmModal(this.app, {
                                title: 'Delete Chapter',
                                message: `Chapter ${chNum} contains ${scenes.length} scene(s). Deleting the chapter removes the column but keeps the scenes (they'll become unassigned). Continue?`,
                                onConfirm: async () => {
                                    for (const s of scenes) {
                                        await this.sceneManager.updateScene(s.filePath, { chapter: undefined });
                                    }
                                    await this.sceneManager.removeChapter(chNum);
                                    await this.sceneManager.setChapterLabel(chNum, '');
                                    this.refreshBoard();
                                    new Notice(`Deleted Chapter ${chNum}`);
                                },
                            });
                        } else {
                            this.sceneManager.removeChapter(chNum).then(() => {
                                this.sceneManager.setChapterLabel(chNum, '').then(() => {
                                    this.refreshBoard();
                                    new Notice(`Deleted Chapter ${chNum}`);
                                });
                            });
                        }
                    });
            });

            // Add existing scenes to this chapter
            menu.addSeparator();
            menu.addItem(item => {
                item.setTitle('Add existing scenes…')
                    .setIcon('plus-circle')
                    .onClick(() => {
                        this.openAssignScenesModal('chapter', chNum);
                    });
            });
        }

        menu.showAtMouseEvent(event);
    }

    /**
     * Open a modal to edit the description for an act or chapter.
     */
    private openDescriptionModal(type: string, num: number, current: string, onSave: (desc: string) => Promise<void>): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(`${type} ${num} Description`);
        const { contentEl } = modal;

        let value = current;
        const descSetting = new Setting(contentEl)
            .setName('Description')
            .setDesc(`A short summary for ${type} ${num}. Leave blank to remove.`);
        const textArea = contentEl.createEl('textarea', {
            cls: 'storyline-description-textarea',
        });
        textArea.value = current;
        textArea.placeholder = 'e.g. "Our heroes arrive in the capital…"';
        textArea.rows = 4;
        textArea.style.width = '100%';
        textArea.style.resize = 'vertical';
        textArea.addEventListener('input', () => { value = textArea.value; });
        setTimeout(() => textArea.focus(), 50);

        const btnRow = contentEl.createDiv('structure-close-row');
        const saveBtn = btnRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
        saveBtn.addEventListener('click', async () => {
            await onSave(value);
            modal.close();
        });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => modal.close());

        modal.open();
    }

    /**
     * Open a small modal to rename an act or chapter label.
     */
    private openRenameModal(type: string, num: number, current: string, onSave: (label: string) => Promise<void>): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(`Rename ${type} ${num}`);
        const { contentEl } = modal;

        let value = current;
        new Setting(contentEl)
            .setName('Label')
            .setDesc(`Display name for ${type} ${num}. Leave blank to remove.`)
            .addText(text => {
                text.setValue(current)
                    .setPlaceholder(`e.g. "The Beginning"`)
                    .onChange(v => { value = v; });
                // Auto-focus
                setTimeout(() => text.inputEl.focus(), 50);
            });

        const btnRow = contentEl.createDiv('structure-close-row');
        const saveBtn = btnRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
        saveBtn.addEventListener('click', async () => {
            await onSave(value);
            modal.close();
        });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => modal.close());

        modal.open();
    }

    /**
     * Open a modal to assign existing scenes to a chapter or act.
     * Shows a checklist of unassigned scenes (those without a chapter/act value).
     */
    private openAssignScenesModal(field: 'chapter' | 'act', value: number): void {
        const modal = new Modal(this.app);
        const rawChLbl = this.sceneManager.getChapterLabel(value);
        const cleanChLbl = rawChLbl?.replace(/^Ch(?:apter)?\s*\d+\s*[—:]\s*/i, '');
        const rawActLbl = this.sceneManager.getActLabel(value);
        const cleanActLbl = rawActLbl?.replace(/^Act\s*\d+\s*[—:]\s*/i, '');
        const label = field === 'chapter'
            ? `Chapter ${value}` + (cleanChLbl ? ` — ${cleanChLbl}` : '')
            : `Act ${value}` + (cleanActLbl ? ` — ${cleanActLbl}` : '');
        modal.titleEl.setText(`Add scenes to ${label}`);

        const { contentEl } = modal;
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: `Select scenes to assign to ${label}. Only scenes not already in a ${field} are shown.`
        });

        const allScenes = this.sceneManager.getFilteredScenes(
            undefined,
            { field: 'sequence', direction: 'asc' }
        );
        // Show scenes without a value for this field, plus scenes in other groups
        const candidates = allScenes.filter(s => {
            const current = field === 'chapter' ? s.chapter : s.act;
            return current === undefined || current !== value;
        });

        if (candidates.length === 0) {
            contentEl.createEl('p', { text: 'All scenes are already assigned.' });
            const closeRow = contentEl.createDiv('structure-close-row');
            closeRow.createEl('button', { text: 'Close', cls: 'mod-cta' })
                .addEventListener('click', () => modal.close());
            modal.open();
            return;
        }

        const selectedPaths = new Set<string>();
        const listEl = contentEl.createDiv('assign-scene-list');
        listEl.style.maxHeight = '400px';
        listEl.style.overflow = 'auto';
        listEl.style.margin = '8px 0';

        for (const scene of candidates) {
            const row = listEl.createDiv('assign-scene-row');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.padding = '4px 0';

            const cb = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
            const currentVal = field === 'chapter' ? scene.chapter : scene.act;
            const info = currentVal !== undefined ? ` [${field} ${currentVal}]` : ' [unassigned]';
            row.createSpan({ text: `${scene.title}${info}` });

            cb.addEventListener('change', () => {
                if (cb.checked) selectedPaths.add(scene.filePath);
                else selectedPaths.delete(scene.filePath);
            });
        }

        const btnRow = contentEl.createDiv('structure-close-row');
        btnRow.style.display = 'flex';
        btnRow.style.gap = '8px';
        btnRow.style.marginTop = '12px';
        const assignBtn = btnRow.createEl('button', { text: 'Assign Selected', cls: 'mod-cta' });
        assignBtn.addEventListener('click', async () => {
            if (selectedPaths.size === 0) {
                new Notice('No scenes selected');
                return;
            }
            for (const fp of selectedPaths) {
                const updates: Partial<Scene> = {};
                if (field === 'chapter') updates.chapter = value;
                else updates.act = value;
                await this.sceneManager.updateScene(fp, updates);
            }
            new Notice(`Assigned ${selectedPaths.size} scene(s) to ${label}`);
            modal.close();
            this.refreshBoard();
        });
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => modal.close());

        modal.open();
    }

    /**
     * Open the structure modal to add/remove empty acts and chapters
     */
    private openStructureModal(): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText('Manage Story Structure');

        const { contentEl } = modal;

        // ── Beat Sheet Templates section ──
        contentEl.createEl('h3', { text: 'Beat Sheet Templates' });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: 'Apply a template to pre-populate your act/chapter structure with named beats.'
        });

        const templateGrid = contentEl.createDiv('beat-sheet-list');
        for (const template of BUILTIN_BEAT_SHEETS) {
            const row = templateGrid.createDiv('beat-sheet-row');

            const textWrap = row.createDiv('beat-sheet-row-text');
            const headerLine = textWrap.createDiv('beat-sheet-row-header');
            headerLine.createSpan({ cls: 'beat-sheet-row-name', text: template.name });
            const info = headerLine.createSpan({ cls: 'beat-sheet-row-info' });
            const parts = [`${template.beats.length} beats`, `${template.acts.length} acts`];
            if (template.chapters.length > 0) parts.push(`${template.chapters.length} chapters`);
            info.textContent = parts.join(' · ');
            textWrap.createDiv({ cls: 'beat-sheet-row-summary', text: template.summary });

            // Expandable beat preview
            const beatList = row.createDiv('beat-sheet-beats-preview');
            for (const beat of template.beats) {
                const beatItem = beatList.createDiv('beat-sheet-beat-item');
                beatItem.createSpan({ cls: 'beat-sheet-beat-act', text: `A${beat.act}` });
                beatItem.createSpan({ cls: 'beat-sheet-beat-label', text: beat.label });
                beatItem.createSpan({ cls: 'beat-sheet-beat-desc', text: beat.description });
            }

            const expandBtn = row.createEl('button', { cls: 'beat-sheet-expand-btn clickable-icon', attr: { 'aria-label': 'Show beats' } });
            expandBtn.textContent = '▸';
            expandBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = row.hasClass('is-expanded');
                // Close all others
                templateGrid.querySelectorAll('.beat-sheet-row.is-expanded').forEach(r => {
                    r.removeClass('is-expanded');
                    (r.querySelector('.beat-sheet-expand-btn') as HTMLElement).textContent = '▸';
                });
                if (!isOpen) {
                    row.addClass('is-expanded');
                    expandBtn.textContent = '▾';
                }
            });

            const applyBtn = row.createEl('button', { text: 'Apply', cls: 'mod-cta beat-sheet-apply-btn' });
            applyBtn.addEventListener('click', async () => {
                await this.sceneManager.applyBeatSheet(template);
                renderActsList();
                renderChaptersList();
                new Notice(`Applied "${template.name}" template`);
            });
        }

        // ── Acts section ──
        contentEl.createEl('h3', { text: 'Acts' });
        const actsDesc = contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: 'Define acts for your story. Empty acts will appear as columns even without scenes.'
        });

        const actsList = contentEl.createDiv('structure-list');
        const definedActs = this.sceneManager.getDefinedActs();
        const scenesPerAct = new Map<number, number>();
        for (const scene of this.sceneManager.getAllScenes()) {
            if (scene.act !== undefined) {
                const n = Number(scene.act);
                scenesPerAct.set(n, (scenesPerAct.get(n) || 0) + 1);
            }
        }

        const renderActsList = () => {
            actsList.empty();
            const acts = this.sceneManager.getDefinedActs();
            const actLabels = this.sceneManager.getActLabels();
            if (acts.length === 0) {
                actsList.createEl('p', { cls: 'structure-empty', text: 'No acts defined yet.' });
            }
            for (const act of acts) {
                const count = scenesPerAct.get(act) || 0;
                const label = actLabels[act];
                const row = actsList.createDiv('structure-row');
                const cleanLabel = label?.replace(/^Act\s*\d+\s*[—:]\s*/i, '');
                const labelText = cleanLabel ? `Act ${act} — ${cleanLabel}` : `Act ${act}`;
                row.createSpan({ cls: 'structure-label', text: labelText });
                row.createSpan({ cls: 'structure-count', text: `${count} scene${count !== 1 ? 's' : ''}` });
                const removeBtn = row.createEl('button', {
                    cls: 'clickable-icon structure-remove',
                    attr: { 'aria-label': `Remove Act ${act}` }
                });
                removeBtn.textContent = '×';
                removeBtn.addEventListener('click', async () => {
                    await this.sceneManager.removeAct(act);
                    renderActsList();
                });
            }
        };
        renderActsList();

        // Add acts controls
        const addActRow = contentEl.createDiv('structure-add-row');
        new Setting(addActRow)
            .setName('Add acts')
            .setDesc('Enter act numbers (e.g. "1,2,3,4,5" or "6" to add one)')
            .addText(text => {
                text.setPlaceholder('1,2,3,4,5');
                text.inputEl.addClass('structure-input');
                (text.inputEl as any)._ref = text;
            })
            .addButton(btn => {
                btn.setButtonText('Add').setCta().onClick(async () => {
                    const input = addActRow.querySelector('.structure-input') as HTMLInputElement;
                    if (!input?.value) return;
                    const nums = input.value.split(',')
                        .map(s => parseInt(s.trim()))
                        .filter(n => !isNaN(n) && n > 0);
                    if (nums.length === 0) {
                        new Notice('Enter valid act numbers (e.g. 1,2,3)');
                        return;
                    }
                    await this.sceneManager.addActs(nums);
                    input.value = '';
                    renderActsList();
                    new Notice(`Added ${nums.length} act(s)`);
                });
            });

        // ── Chapters section ──
        contentEl.createEl('h3', { text: 'Chapters' });
        contentEl.createEl('p', {
            cls: 'setting-item-description',
            text: 'Define chapters. Empty chapters appear as columns when grouping by chapter.'
        });

        const chaptersList = contentEl.createDiv('structure-list');
        const scenesPerChapter = new Map<number, number>();
        for (const scene of this.sceneManager.getAllScenes()) {
            if (scene.chapter !== undefined) {
                const n = Number(scene.chapter);
                scenesPerChapter.set(n, (scenesPerChapter.get(n) || 0) + 1);
            }
        }

        const renderChaptersList = () => {
            chaptersList.empty();
            const chapters = this.sceneManager.getDefinedChapters();
            const chLabels = this.sceneManager.getChapterLabels();
            if (chapters.length === 0) {
                chaptersList.createEl('p', { cls: 'structure-empty', text: 'No chapters defined yet.' });
            }
            for (const ch of chapters) {
                const count = scenesPerChapter.get(ch) || 0;
                const chLabel = chLabels[ch];
                const row = chaptersList.createDiv('structure-row');
                const cleanChLabel = chLabel?.replace(/^Ch(?:apter)?\s*\d+\s*[—:]\s*/i, '');
                const labelText = cleanChLabel ? `Chapter ${ch} — ${cleanChLabel}` : `Chapter ${ch}`;
                row.createSpan({ cls: 'structure-label', text: labelText });
                row.createSpan({ cls: 'structure-count', text: `${count} scene${count !== 1 ? 's' : ''}` });
                const removeBtn = row.createEl('button', {
                    cls: 'clickable-icon structure-remove',
                    attr: { 'aria-label': `Remove Chapter ${ch}` }
                });
                removeBtn.textContent = '×';
                removeBtn.addEventListener('click', async () => {
                    await this.sceneManager.removeChapter(ch);
                    renderChaptersList();
                });
            }
        };
        renderChaptersList();

        const addChapterRow = contentEl.createDiv('structure-add-row');
        let createScenesForChapters = false;
        new Setting(addChapterRow)
            .setName('Add chapters')
            .setDesc('Enter chapter numbers (e.g. "1-10" or "1,2,3")')
            .addText(text => {
                text.setPlaceholder('1-10');
                text.inputEl.addClass('structure-input');
            })
            .addButton(btn => {
                btn.setButtonText('Add').setCta().onClick(async () => {
                    const input = addChapterRow.querySelector('.structure-input') as HTMLInputElement;
                    if (!input?.value) return;
                    let nums: number[] = [];
                    const val = input.value.trim();
                    // Support range syntax: "1-10"
                    const rangeMatch = val.match(/^(\d+)\s*-\s*(\d+)$/);
                    if (rangeMatch) {
                        const start = parseInt(rangeMatch[1]);
                        const end = parseInt(rangeMatch[2]);
                        for (let i = start; i <= end; i++) nums.push(i);
                    } else {
                        nums = val.split(',')
                            .map(s => parseInt(s.trim()))
                            .filter(n => !isNaN(n) && n > 0);
                    }
                    if (nums.length === 0) {
                        new Notice('Enter valid chapter numbers (e.g. 1-10 or 1,2,3)');
                        return;
                    }
                    await this.sceneManager.addChapters(nums);

                    // Optionally create one empty scene per chapter
                    if (createScenesForChapters) {
                        const chLabels = this.sceneManager.getChapterLabels();
                        for (const ch of nums) {
                            const label = chLabels[ch];
                            const title = label ? `Chapter ${ch} — ${label}` : `Chapter ${ch}`;
                            await this.sceneManager.createScene({
                                title,
                                chapter: ch,
                                sequence: ch,
                                status: 'idea' as any,
                            });
                        }
                    }

                    input.value = '';
                    renderChaptersList();
                    const msg = createScenesForChapters
                        ? `Added ${nums.length} chapter(s) with empty scenes — visible in all views.`
                        : `Added ${nums.length} chapter(s). Group by Chapter in Kanban to see them.`;
                    new Notice(msg);
                });
            });

        new Setting(addChapterRow)
            .setName('Create an empty scene per chapter')
            .setDesc('Makes new chapters immediately visible in all views.')
            .addToggle(toggle => {
                toggle.setValue(false);
                toggle.onChange(v => { createScenesForChapters = v; });
            });

        // Close button
        const closeRow = contentEl.createDiv('structure-close-row');
        const closeBtn = closeRow.createEl('button', { text: 'Done', cls: 'mod-cta' });
        closeBtn.addEventListener('click', () => {
            modal.close();
            this.refreshBoard();
        });

        modal.open();
    }

    /**
     * Open the Quick Add modal
     */
    private openQuickAdd(presetColumn?: string): void {
        // Build defaults based on groupBy and column title
        const defaults: Partial<Scene> = {};
        if (presetColumn) {
            if (this.groupBy === 'act') {
                // Accept any value after "Act " (numeric, decimal, or string)
                // and let parseActChapterInput decide whether to store it as
                // a number ("7" → 7) or a string ("1.1", "Prologue").
                const match = presetColumn.match(/^Act\s+(.+)$/);
                if (match) defaults.act = parseActChapterInput(match[1]);
            } else if (this.groupBy === 'chapter') {
                const match = presetColumn.match(/^Chapter\s+(.+)$/);
                if (match) defaults.chapter = parseActChapterInput(match[1]);
            } else if (this.groupBy === 'status') {
                // Build a label→id mapping from the dynamic status config
                const cfg = getStatusConfig();
                const statusMap: Record<string, string> = {};
                for (const [id, def] of Object.entries(cfg)) {
                    statusMap[def.label] = id;
                }
                const statusVal = statusMap[presetColumn] || presetColumn.toLowerCase();
                defaults.status = statusVal as any;
            } else if (this.groupBy === 'pov') {
                if (presetColumn !== 'No POV') defaults.pov = presetColumn;
            }
        }

        const modal = new QuickAddModal(
            this.app,
            this.plugin,
            this.sceneManager,
            async (sceneData, openAfter) => {
                const file = await this.sceneManager.createScene(sceneData);
                this.refreshBoard();

                if (openAfter) {
                    await this.app.workspace.getLeaf('tab').openFile(file, { state: { mode: 'source', source: false } });
                }
            },
            defaults
        );
        modal.open();
    }

    private getCurrentMaxCorkboardZ(): number {
        let max = 0;
        for (const pos of this.corkboardPositions.values()) {
            if ((pos.z ?? 0) > max) max = pos.z ?? 0;
        }
        return max;
    }

    private getNextQuickNotePosition(): { x: number; y: number; z: number } {
        const now = Date.now();
        if (now - this.quickNoteLastCreatedAt <= 8000) {
            this.quickNoteChainIndex += 1;
        } else {
            this.quickNoteChainIndex = 0;
        }
        this.quickNoteLastCreatedAt = now;

        const offset = this.quickNoteChainIndex * 28;
        const viewport = this.boardEl?.querySelector('.story-line-corkboard-viewport') as HTMLElement | null;
        const zoom = this.corkboardCamera.zoom || 1;

        let centerWorldX = 0;
        let centerWorldY = 0;

        if (viewport) {
            const rect = viewport.getBoundingClientRect();
            centerWorldX = ((rect.width / 2) - this.corkboardCamera.x) / zoom;
            centerWorldY = ((rect.height / 2) - this.corkboardCamera.y) / zoom;
        } else {
            centerWorldX = (-this.corkboardCamera.x) / zoom;
            centerWorldY = (-this.corkboardCamera.y) / zoom;
        }

        return {
            x: centerWorldX - 140 + offset,
            y: centerWorldY - 110 + offset,
            z: this.getCurrentMaxCorkboardZ() + 1,
        };
    }

    /**
     * Refresh the board display
     */
    refreshBoard(): void {
        this.configureDragToPan();
        if (this.boardMode === 'corkboard') {
            this.ensureCorkboardLayoutLoaded();
            this.renderCorkboard();
        } else {
            this.saveColumnScrollPositions();
            this.renderBoard();
            // Restore scroll positions after DOM is rebuilt
            requestAnimationFrame(() => this.restoreColumnScrollPositions());
        }
        // Only refresh inspector if it was already visible
        if (this.selectedScene && this.inspectorComponent?.isVisible()) {
            const updated = this.sceneManager.getScene(this.selectedScene.filePath);
            if (updated) {
                this.selectedScene = updated;
                this.inspectorComponent?.show(updated);
            }
        }
    }

    /**
     * Full refresh called by the plugin on file changes
     */
    refresh(): void {
        if (!this.rootContainer) return;
        if (this._pendingRefresh) { cancelAnimationFrame(this._pendingRefresh); }
        this._pendingRefresh = requestAnimationFrame(() => {
            this._pendingRefresh = null;
            if (!this.rootContainer) return;
            this._lastCacheVersion = this.sceneManager.cacheVersion;
            const prevSelectedPath = this.selectedScene?.filePath ?? null;
            const inspectorWasVisible = this.inspectorComponent?.isVisible() ?? false;

            if (this.boardEl) {
                this.refreshBoard();
            } else {
                this.saveColumnScrollPositions();
                this.renderView(this.rootContainer);
                requestAnimationFrame(() => this.restoreColumnScrollPositions());
            }

            if (prevSelectedPath) {
                const updated = this.sceneManager.getScene(prevSelectedPath);
                if (updated) {
                    this.selectedScene = updated;
                    this.selectedScenes.add(updated.filePath);
                    if (inspectorWasVisible) {
                        this.inspectorComponent?.show(updated);
                    }
                }
            }
        });
    }

    private configureDragToPan(): void {
        if (!this.boardEl) return;

        if (this.boardMode !== 'corkboard' && this.corkboardInteractionCleanup) {
            this.corkboardInteractionCleanup();
            this.corkboardInteractionCleanup = null;
        }

        if (this.dragToPanCleanup) {
            this.dragToPanCleanup();
            this.dragToPanCleanup = null;
        }

        if (this.boardMode === 'kanban') {
            this.dragToPanCleanup = enableDragToPan(this.boardEl);
        }
    }

    private async openQuickAddIdea(): Promise<void> {
        // Clear selection so the inspector doesn't pop open for the previous scene
        this.selectedScene = null;
        this.selectedScenes.clear();
        this.inspectorComponent?.hide();

        const file = await this.sceneManager.createScene({
            status: 'idea',
            corkboardNote: true,
        });

        const pos = this.getNextQuickNotePosition();
        this.corkboardPositions.set(file.path, pos);
        this.schedulePersistCorkboardLayout();

        this.refreshBoard();
    }

    // ── Image sticky note helpers ────────────────────────

    /**
     * Render the content for an image sticky note (image + caption + footer).
     */
    private renderImageNoteContent(cardEl: HTMLElement, scene: Scene): void {
        const editorWrap = cardEl.createDiv('story-line-corkboard-note-editor story-line-corkboard-image-editor');

        // Image element
        const imgSrc = resolveImagePath(this.app, scene.corkboardNoteImage!);
        const imgEl = editorWrap.createEl('img', {
            cls: 'story-line-corkboard-note-img',
            attr: { src: imgSrc, alt: scene.corkboardNoteCaption || 'Image note' },
        });

        // Click image → open lightbox
        imgEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openImageLightbox(imgSrc, scene.corkboardNoteCaption);
        });

        // Caption (editable, supports markdown/wikilinks)
        const caption = scene.corkboardNoteCaption ?? '';
        const captionPreview = editorWrap.createDiv('story-line-corkboard-note-caption markdown-rendered');
        const captionInput = editorWrap.createEl('textarea', {
            cls: 'story-line-corkboard-note-caption-input',
            attr: { placeholder: 'Add a caption…', rows: '2' },
        });
        captionInput.value = caption;
        captionInput.style.display = 'none';

        const renderCaptionPreview = async () => {
            captionPreview.empty();
            const text = captionInput.value.trim();
            if (!text) {
                captionPreview.createSpan({ cls: 'story-line-corkboard-note-caption-empty', text: 'Add a caption…' });
                return;
            }
            await MarkdownRenderer.render(this.app, text, captionPreview, scene.filePath, this);
        };

        const saveCaptionAndClose = async () => {
            const next = captionInput.value;
            if ((scene.corkboardNoteCaption || '') !== next) {
                await this.sceneManager.updateScene(scene.filePath, { corkboardNoteCaption: next });
                scene.corkboardNoteCaption = next;
            }
            captionInput.style.display = 'none';
            captionPreview.style.display = 'block';
            await renderCaptionPreview();
        };

        captionPreview.addEventListener('click', (e) => {
            // Allow internal links to work
            const link = (e.target as HTMLElement).closest('a');
            if (link) {
                const href = link.getAttribute('data-href') || link.getAttribute('href');
                if (href && link.hasClass('internal-link')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.app.workspace.openLinkText(href, scene.filePath, true);
                    return;
                }
                if (href && !href.startsWith('#')) return;
            }
            captionPreview.style.display = 'none';
            captionInput.style.display = 'block';
            captionInput.focus();

            // Listen for clicks outside the caption to close the editor
            const outsideHandler = (pe: PointerEvent) => {
                const target = pe.target as Node | null;
                if (target && editorWrap.contains(target)) return;
                document.removeEventListener('pointerdown', outsideHandler, true);
                void saveCaptionAndClose();
            };
            window.setTimeout(() => {
                document.addEventListener('pointerdown', outsideHandler, true);
            }, 0);
        });

        captionInput.addEventListener('blur', () => { void saveCaptionAndClose(); });
        captionInput.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); void saveCaptionAndClose(); }
        });

        void renderCaptionPreview();

        // Resize handle
        const resizeHandle = cardEl.createDiv('story-line-corkboard-note-resize-handle');
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const startY = e.clientY;
            const zoom = this.corkboardCamera.zoom || 1;
            const startHeight = cardEl.getBoundingClientRect().height / zoom;
            const minHeight = 180;
            const onMove = (me: PointerEvent) => {
                cardEl.style.height = `${Math.max(minHeight, startHeight + (me.clientY - startY) / zoom)}px`;
            };
            const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                const finalHeight = parseFloat(cardEl.style.height);
                if (finalHeight > 0) {
                    const pos = this.corkboardPositions.get(scene.filePath);
                    if (pos) {
                        pos.h = finalHeight;
                        this.schedulePersistCorkboardLayout();
                    }
                }
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
    }

    /**
     * Open a floating, draggable, resizable lightbox — same style as Location/Codex galleries.
     */
    private openImageLightbox(src: string, caption?: string): void {
        // Close any existing lightbox
        document.querySelector('.gallery-lightbox-window')?.remove();

        const winWidth = Math.min(600, window.innerWidth - 40);
        const winHeight = Math.round(winWidth * 3 / 4) + 36 + 28;

        const win = document.body.createDiv('gallery-lightbox-window');
        win.style.width = `${winWidth}px`;
        win.style.height = `${winHeight}px`;

        // Titlebar
        const titlebar = win.createDiv('gallery-lightbox-titlebar');
        titlebar.createSpan({ cls: 'gallery-lightbox-title', text: caption || 'Image' });
        const closeBtn = titlebar.createEl('button', { cls: 'gallery-lightbox-close', attr: { title: 'Close' } });
        obsidian.setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => { cleanup(); win.remove(); });

        // Image content
        const contentRow = win.createDiv('gallery-lightbox-content-row');
        const imgContainer = contentRow.createDiv('gallery-lightbox-content');
        if (src) {
            const img = imgContainer.createEl('img', { attr: { src, alt: caption || 'Image note' } });
            img.style.transformOrigin = 'center center';
        }

        // Caption
        if (caption) {
            const captionEl = win.createDiv('gallery-lightbox-caption');
            captionEl.textContent = caption;
        }

        // Resize handle
        const resizeHandle = win.createDiv('gallery-lightbox-resize-handle');

        // Scroll to zoom
        let zoom = 1;
        imgContainer.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            zoom = Math.max(0.5, Math.min(5, zoom + delta));
            const img = imgContainer.querySelector('img');
            if (img) img.style.transform = `scale(${zoom})`;
        }, { passive: false });

        // Drag titlebar
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;
        titlebar.addEventListener('pointerdown', (e: PointerEvent) => {
            if ((e.target as HTMLElement).closest('.gallery-lightbox-close')) return;
            isDragging = true;
            const rect = win.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            win.style.left = `${rect.left}px`;
            win.style.top = `${rect.top}px`;
            win.style.transform = 'none';
            titlebar.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        titlebar.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isDragging) return;
            win.style.left = `${e.clientX - dragOffsetX}px`;
            win.style.top = `${e.clientY - dragOffsetY}px`;
        });
        titlebar.addEventListener('pointerup', () => { isDragging = false; });
        titlebar.addEventListener('lostpointercapture', () => { isDragging = false; });

        // Resize handle
        let isResizing = false;
        let resizeStartX = 0, resizeStartY = 0, startW = 0, startH = 0;
        resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            isResizing = true;
            resizeStartX = e.clientX; resizeStartY = e.clientY;
            startW = win.offsetWidth; startH = win.offsetHeight;
            resizeHandle.setPointerCapture(e.pointerId);
            e.preventDefault(); e.stopPropagation();
        });
        resizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isResizing) return;
            win.style.width = `${Math.max(200, startW + (e.clientX - resizeStartX))}px`;
            win.style.height = `${Math.max(150, startH + (e.clientY - resizeStartY))}px`;
        });
        resizeHandle.addEventListener('pointerup', () => { isResizing = false; });
        resizeHandle.addEventListener('lostpointercapture', () => { isResizing = false; });

        // Escape to close
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { cleanup(); win.remove(); } };
        document.addEventListener('keydown', onKey);
        const cleanup = () => { document.removeEventListener('keydown', onKey); };
    }

    /**
     * Open ImagePicker and create a new image sticky note with the selected image.
     */
    private async openImageNotePicker(): Promise<void> {
        const sceneFolder = this.sceneManager.getSceneFolder() ?? '';
        const { pickImage } = await import('../components/ImagePicker');
        const imagePath = await pickImage(this.app, sceneFolder);
        if (!imagePath) return;

        this.selectedScene = null;
        this.selectedScenes.clear();
        this.inspectorComponent?.hide();

        const file = await this.sceneManager.createScene({
            status: 'idea',
            corkboardNote: true,
            corkboardNoteImage: imagePath,
        });

        const pos = this.getNextQuickNotePosition();
        this.corkboardPositions.set(file.path, pos);
        this.schedulePersistCorkboardLayout();
        this.refreshBoard();
    }

    /**
     * Open ImagePicker to set or change the image on an existing sticky note.
     */
    private async changeNoteImage(scene: Scene): Promise<void> {
        const sceneFolder = this.sceneManager.getSceneFolder() ?? '';
        const { pickImage } = await import('../components/ImagePicker');
        const imagePath = await pickImage(this.app, sceneFolder, scene.corkboardNoteImage);
        if (!imagePath) return;

        await this.sceneManager.updateScene(scene.filePath, {
            corkboardNoteImage: imagePath,
        });
        scene.corkboardNoteImage = imagePath;
        this.refreshBoard();
    }

    /**
     * Create an image note from a vault path at given corkboard coordinates.
     */
    private async createImageNoteAtPosition(imagePath: string, worldX: number, worldY: number): Promise<void> {
        const file = await this.sceneManager.createScene({
            status: 'idea',
            corkboardNote: true,
            corkboardNoteImage: imagePath,
        });

        this.corkboardPositions.set(file.path, {
            x: worldX,
            y: worldY,
            z: this.getCurrentMaxCorkboardZ() + 1,
        });
        this.schedulePersistCorkboardLayout();
        this.refreshBoard();
    }

    /**
     * Import a file dropped from outside the vault into Images/ and create an image note.
     */
    private async importExternalImageAndCreate(file: File, worldX: number, worldY: number): Promise<void> {
        const sceneFolder = this.sceneManager.getSceneFolder() ?? '';
        const projectRoot = sceneFolder.replace(/\\/g, '/').replace(/\/Scenes\/?$/, '');
        const imagesFolder = `${projectRoot}/Images`;

        if (!(await this.app.vault.adapter.exists(imagesFolder))) {
            await this.app.vault.createFolder(imagesFolder);
        }

        const buffer = await file.arrayBuffer();
        let fileName = file.name;
        let targetPath = `${imagesFolder}/${fileName}`;
        let counter = 1;
        while (await this.app.vault.adapter.exists(targetPath)) {
            const ext = fileName.lastIndexOf('.') >= 0 ? fileName.slice(fileName.lastIndexOf('.')) : '';
            const base = fileName.lastIndexOf('.') >= 0 ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;
            targetPath = `${imagesFolder}/${base}-${counter}${ext}`;
            counter++;
        }

        await this.app.vault.createBinary(targetPath, buffer);
        new Notice(`Image imported: ${targetPath.split('/').pop()}`);
        await this.createImageNoteAtPosition(targetPath, worldX, worldY);
    }

    /**
     * Attach dragover / drop listeners so images can be dropped onto the corkboard.
     * Handles both vault-internal drags (Obsidian TFile) and external file drops.
     */
    private attachCorkboardImageDrop(viewport: HTMLElement): void {
        const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

        viewport.addEventListener('dragover', (e: DragEvent) => {
            if (!e.dataTransfer) return;

            // Accept vault file drags (Obsidian sets text/plain to the path)
            const plain = e.dataTransfer.getData('text/plain');
            if (plain && IMAGE_EXTENSIONS.test(plain)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                return;
            }

            // Accept external files
            if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        viewport.addEventListener('drop', (e: DragEvent) => {
            if (!e.dataTransfer) return;

            const rect = viewport.getBoundingClientRect();
            const zoom = this.corkboardCamera.zoom || 1;
            const worldX = (e.clientX - rect.left - this.corkboardCamera.x) / zoom;
            const worldY = (e.clientY - rect.top - this.corkboardCamera.y) / zoom;

            // 1. Try vault-internal drag (Obsidian internal drag sets text/plain)
            const plain = e.dataTransfer.getData('text/plain');
            if (plain && IMAGE_EXTENSIONS.test(plain)) {
                e.preventDefault();
                const file = this.app.vault.getAbstractFileByPath(plain);
                if (file instanceof TFile) {
                    void this.createImageNoteAtPosition(file.path, worldX, worldY);
                    return;
                }
            }

            // 2. Try external file drop
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    const f = files[i];
                    if (IMAGE_EXTENSIONS.test(f.name)) {
                        e.preventDefault();
                        void this.importExternalImageAndCreate(f, worldX + i * 30, worldY + i * 30);
                    }
                }
            }
        });
    }

    /**
     * Sort group keys intelligently
     */
    private sortGroupKeys(keys: string[]): string[] {
        return keys.sort((a, b) => {
            // "No X" / "No Act" / "No Chapter" groups always go last.
            const aNo = a.startsWith('No ');
            const bNo = b.startsWith('No ');
            if (aNo !== bNo) return aNo ? 1 : -1;

            // For "Act ..." or "Chapter ..." columns, compare the suffix using
            // the numeric-aware act/chapter comparator so "Act 2" sorts before
            // "Act 10" and hierarchical names like "Act 1.1" / "Act 1.10" /
            // "Act 2.1" stay in order.
            const actA = a.match(/^Act\s+(.+)$/);
            const actB = b.match(/^Act\s+(.+)$/);
            if (actA && actB) return compareActChapter(actA[1], actB[1]);

            const chA = a.match(/^Chapter\s+(.+)$/);
            const chB = b.match(/^Chapter\s+(.+)$/);
            if (chA && chB) return compareActChapter(chA[1], chB[1]);

            // Status / POV / mixed: locale string compare with numeric awareness.
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        });
    }
}
