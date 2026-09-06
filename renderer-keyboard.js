function handleKeyboard(event) {
    // Preserve modal priority so one key cannot act on multiple views.
    if (imageModal.classList.contains('show')) {
        handleImageModalKeyboard(event);
        return;
    }
    if (competitionModal.classList.contains('show')) {
        handleCompetitionKeyboard(event);
        return;
    }
    if (settingsModal.classList.contains('show')) {
        if (event.key === 'Escape') closeSettings();
        return;
    }
    if (currentViewMode === 'waterfall') {
        handleWaterfallKeyboard(event);
    }
}

function handleImageModalKeyboard(event) {
    if (isEditableTarget(event.target)) {
        if (event.key === 'Escape') closeModal();
        return;
    }
    if (handleImageModalShortcut(event) || handleTagShortcut(event)) return;

    switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
            event.preventDefault();
            showPrevImage();
            break;
        case 'ArrowRight':
        case 'ArrowDown':
            event.preventDefault();
            showNextImage();
            break;
        case 'Escape':
            closeModal();
            break;
        case 'Delete':
            event.preventDefault();
            void deleteCurrentImage();
            break;
        case '+':
        case '=':
            event.preventDefault();
            zoomIn();
            break;
        case '-':
            event.preventDefault();
            zoomOut();
            break;
        case '0':
            event.preventDefault();
            zoomReset();
            break;
    }
}

function handleCompetitionKeyboard(event) {
    if (event.key === 'Escape') {
        closeCompetition();
    } else if (/^[1-8]$/.test(event.key)) {
        event.preventDefault();
        chooseCompetitionWinner(Number(event.key) - 1);
    } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        chooseCompetitionWinner(0);
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        chooseCompetitionWinner(1);
    }
}

function handleWaterfallKeyboard(event) {
    if (isEditableTarget(event.target)) return;

    const isUnmodifiedSpace = (event.key === ' ' || event.code === 'Space') &&
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.key === 'ArrowDown' || isUnmodifiedSpace) {
        event.preventDefault();
        if (!event.repeat) void advanceWaterfallPage();
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!event.repeat) void restorePreviousWaterfallPage();
    }
}

function handleImageModalShortcut(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditableTarget(event.target)) {
        return false;
    }

    const shortcut = normalizeShortcut(event.key);
    if (shortcut === FAVORITE_IMAGE_SHORTCUT) {
        event.preventDefault();
        if (!event.repeat) {
            void toggleHeartTagForCurrentImage(event, { autoAdvance: true });
        }
        return true;
    }

    if (shortcut === DELETE_IMAGE_SHORTCUT) {
        event.preventDefault();
        if (!event.repeat) {
            void deleteCurrentImage();
        }
        return true;
    }

    return false;
}

function handleTagShortcut(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditableTarget(event.target)) {
        return false;
    }

    const tag = getTagByShortcut(event.key);
    if (!tag) return false;

    event.preventDefault();
    toggleCurrentImageTag(tag.name, { showFeedback: true, autoAdvance: true });
    return true;
}
