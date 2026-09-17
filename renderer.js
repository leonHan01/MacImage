bindToolbarEvents();
bindGalleryEvents();
bindSettingsEvents();
bindCompetitionEvents();
bindModalEvents();
document.addEventListener('keydown', handleKeyboard);
document.addEventListener('fullscreenchange', syncWaterfallFullscreen);
setSidebarCollapsed(isSidebarCollapsed, { persist: false });
bindElectronEvents();

init().then(() => {
    return window.electronAPI.rendererReady();
}).catch((error) => {
    console.error('Failed to initialize app:', error);
});

function bindToolbarEvents() {
    document.getElementById('openFolderBtn').addEventListener('click', openFolder);
    document.getElementById('loadServerImagesBtn').addEventListener('click', loadServerImages);
    document.getElementById('openCurrentFolderBtn').addEventListener('click', openCurrentFolderInFinder);
    document.getElementById('toggleSidebarBtn').addEventListener('click', toggleSidebar);
    document.getElementById('quickOpenFolderBtn').addEventListener('click', openQuickFolder);
}

function bindGalleryEvents() {
    imageGrid.addEventListener('click', (event) => {
        if (handleWaterfallGridClick(event)) return;

        const item = event.target.closest('.file-item');
        if (!item) return;

        openImageModal(parseInt(item.dataset.index, 10));
    });

    imageGrid.addEventListener('contextmenu', (event) => {
        if (handleWaterfallContextMenu(event)) {
            event.preventDefault();
        }
    });

    imageGrid.addEventListener('scroll', scheduleVirtualGridRender);
    imageGrid.addEventListener('wheel', (event) => {
        if (handleWaterfallWheel(event)) {
            event.preventDefault();
        }
    }, { passive: false });
    window.addEventListener('resize', refreshVirtualGridLayout);

    tagFilter.addEventListener('click', (event) => {
        const tagEl = event.target.closest('.filter-tag');
        if (!tagEl) return;

        toggleFilterTag(tagEl.dataset.tag);
    });

    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            if (currentSort === 'random') {
                resetRandomSortOrder();
            }
            renderImages();
        });
    }

    document.querySelectorAll('.view-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setViewMode(btn.dataset.view));
    });
}

function bindSettingsEvents() {
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('settingsClose').addEventListener('click', closeSettings);
    document.getElementById('chooseQuickOpenFolderBtn').addEventListener('click', chooseQuickOpenFolder);
    document.getElementById('addQuickOpenFolderBtn').addEventListener('click', addQuickOpenFolder);
    document.getElementById('addTagBtn').addEventListener('click', saveTagFromForm);
    document.getElementById('quickAddTagBtn').addEventListener('click', quickAddTag);
    document.getElementById('addCategoryBtn')?.addEventListener('click', saveCategoryFromForm);

    const newCategoryName = document.getElementById('newCategoryName');
    if (newCategoryName) {
        newCategoryName.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') saveCategoryFromForm();
        });
    }

    document.getElementById('emptyTrashBtn')?.addEventListener('click', emptyTrash);
    document.getElementById('clearRecentOpenFilesBtn')?.addEventListener('click', clearRecentOpenFiles);
    document.getElementById('exportConfigBtn')?.addEventListener('click', exportConfig);
    document.getElementById('importConfigBtn')?.addEventListener('click', importConfig);
    document.getElementById('scanDuplicatesBtn')?.addEventListener('click', scanDuplicateImages);
    document.getElementById('deleteDuplicateImagesBtn')?.addEventListener('click', deleteDuplicateImagesDistinct);
    document.getElementById('scanSmallImagesBtn')?.addEventListener('click', scanSmallImages);
    document.getElementById('deleteSmallImagesBtn')?.addEventListener('click', deleteSmallImages);
    document.getElementById('smallImageThresholdInput')?.addEventListener('change', updateSmallImageThreshold);
    document.getElementById('selectMigrateFolderBtn')?.addEventListener('click', selectMigrateFolder);
    document.getElementById('selectServerDownloadFolderBtn')?.addEventListener('click', selectServerDownloadFolder);
    document.getElementById('serverDownloadConcurrencyInput')?.addEventListener('change', saveServerDownloadConcurrency);
    document.getElementById('migrateImagesBtn')?.addEventListener('click', migrateImages);
    document.getElementById('newTagInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') saveTagFromForm();
    });
    document.getElementById('quickTagInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') quickAddTag();
    });

    settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettings);
}

function bindCompetitionEvents() {
    document.getElementById('startCompetitionBtn')?.addEventListener('click', startImageCompetition);
    document.getElementById('competitionClose')?.addEventListener('click', closeCompetition);

    const competitionBody = document.getElementById('competitionBody');
    if (competitionBody) {
        competitionBody.addEventListener('click', (event) => {
            const button = event.target.closest('.competition-image-btn[data-choice-index]');
            if (!button) return;
            chooseCompetitionWinner(Number(button.dataset.choiceIndex));
        });
    }

    const competitionGroupSizeSelect = document.getElementById('competitionGroupSizeSelect');
    if (competitionGroupSizeSelect) {
        competitionGroupSizeSelect.addEventListener('change', (event) => {
            setCompetitionGroupSize(event.target.value);
        });
    }

    document.getElementById('competitionRevealBtn')?.addEventListener('click', revealCompetitionChampion);
    document.getElementById('competitionRestartBtn')?.addEventListener('click', restartImageCompetition);

    competitionModal.querySelector('.modal-backdrop').addEventListener('click', closeCompetition);
}

function bindModalEvents() {
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('toggleModalTagsBtn').addEventListener('click', toggleModalTags);
    document.getElementById('showModalTagsBtn').addEventListener('click', () => setModalTagsExpanded(true));
    document.getElementById('modalPrev').addEventListener('click', showPrevImage);
    document.getElementById('modalNext').addEventListener('click', showNextImage);
    document.getElementById('deleteBtn').addEventListener('click', deleteCurrentImage);
    document.getElementById('modalQuickAddTagBtn').addEventListener('click', modalQuickAddTag);
    document.getElementById('showInFolderBtn').addEventListener('click', showCurrentImageInFolder);
    document.getElementById('zoomInBtn')?.addEventListener('click', zoomIn);
    document.getElementById('zoomOutBtn')?.addEventListener('click', zoomOut);
    document.getElementById('zoomResetBtn')?.addEventListener('click', zoomReset);
    document.getElementById('modalQuickTagInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') modalQuickAddTag();
    });

    imageModal.querySelector('.modal-backdrop').addEventListener('click', closeModal);

    const modalImageContainer = document.querySelector('.modal-image-container');
    if (modalImageContainer) {
        modalImageContainer.addEventListener('dblclick', handleModalFavoriteDblClick);
        modalImageContainer.addEventListener('contextmenu', handleModalDeleteContextMenu);
        modalImageContainer.addEventListener('wheel', handleModalWheel);
    }

    bindModalImageGestures();
}

function bindElectronEvents() {
    window.electronAPI.onOpenFolder(async (folderPath) => {
        await loadFolder(folderPath);
    });

    window.electronAPI.onOpenImageFile(async (imageInfo) => {
        await loadImageFile(imageInfo);
    });

    window.electronAPI.onTrashFolderChanged((folderPath) => {
        trashFolder = folderPath;
        updateTrashFolderDisplay();
    });

    window.electronAPI.onUndoDelete(() => {
        undoLastDelete();
    });
}

function toggleSidebar() {
    setSidebarCollapsed(!isSidebarCollapsed);
}

function setSidebarCollapsed(collapsed, options = {}) {
    isSidebarCollapsed = Boolean(collapsed);
    const appContainer = document.querySelector('.app-container');
    const toggleButton = document.getElementById('toggleSidebarBtn');

    appContainer?.classList.toggle('sidebar-hidden', isSidebarCollapsed);
    if (toggleButton) {
        toggleButton.setAttribute('aria-expanded', String(!isSidebarCollapsed));
        toggleButton.title = isSidebarCollapsed ? '显示标签栏' : '隐藏标签栏';
        toggleButton.classList.toggle('sidebar-is-hidden', isSidebarCollapsed);
    }
    if (options.persist !== false) {
        localStorage.setItem('macimage:sidebarCollapsed', String(isSidebarCollapsed));
    }

    requestAnimationFrame(() => refreshVirtualGridLayout());
}
