(function exposeImagePreviewState(root, factory) {
    const imagePreviewState = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = imagePreviewState;
        return;
    }

    root.MacImagePreviewState = imagePreviewState;
}(typeof globalThis === 'object' ? globalThis : this, () => {
    const MIN_ZOOM = 0.25;
    const MAX_ZOOM = 5;

    function create() {
        let index = -1;
        let imagePath = null;
        let zoom = 1;
        let translateX = 0;
        let translateY = 0;
        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;

        function snapshot() {
            return { index, imagePath, zoom, translateX, translateY, isDragging };
        }

        function select(images, nextIndex) {
            if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= images.length) {
                return false;
            }

            index = nextIndex;
            imagePath = images[index].path;
            resetTransform();
            return true;
        }

        function reconcile(images) {
            if (index < 0) return false;
            if (images.length === 0) {
                close();
                return false;
            }

            const retainedIndex = images.findIndex(image => image.path === imagePath);
            if (retainedIndex >= 0) {
                index = retainedIndex;
                return true;
            }

            return select(images, Math.min(index, images.length - 1));
        }

        function move(images, offset) {
            return select(images, index + offset);
        }

        function close() {
            index = -1;
            imagePath = null;
            resetTransform();
        }

        function zoomBy(factor) {
            zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
            if (zoom <= 1) {
                translateX = 0;
                translateY = 0;
            }
        }

        function resetTransform() {
            zoom = 1;
            translateX = 0;
            translateY = 0;
            endDrag();
        }

        function startDrag(x, y) {
            if (zoom <= 1) return false;

            isDragging = true;
            dragStartX = x - translateX * zoom;
            dragStartY = y - translateY * zoom;
            return true;
        }

        function dragTo(x, y) {
            if (!isDragging || zoom <= 1) return false;

            translateX = (x - dragStartX) / zoom;
            translateY = (y - dragStartY) / zoom;
            return true;
        }

        function endDrag() {
            isDragging = false;
        }

        return Object.freeze({
            snapshot,
            select,
            reconcile,
            move,
            close,
            zoomBy,
            resetTransform,
            startDrag,
            dragTo,
            endDrag
        });
    }

    return Object.freeze({ create });
}));
