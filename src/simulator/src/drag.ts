import interact from 'interactjs'

interface Position {
    x: number
    y: number
}

// Step 1: persistent WeakMap to store positions across multiple draggables
const positions = new WeakMap<HTMLElement, Position>()

function updatePosition(
    element: HTMLElement,
    dx: number,
    dy: number,
    positions: WeakMap<HTMLElement, Position>
): void {
    if (!element) return // Check if the element is valid

    // Get or create position
    const pos = positions.get(element) || { x: 0, y: 0 }
    positions.set(element, pos)

    // Compute new position
    const newX = pos.x + dx
    const newY = pos.y + dy

    // Only update DOM if position changed
    if (newX !== pos.x || newY !== pos.y) {
        pos.x = newX
        pos.y = newY
        element.style.transform = `translate(${newX}px, ${newY}px)`
    }
}

function disableSelection(element: HTMLElement): void {
    element.setAttribute('unselectable', 'on')
    element.style.userSelect = 'none'
    element.style.webkitUserSelect = 'none'
    element.style.MozUserSelect = 'none'
    element.style.msUserSelect = 'none'
    element.style.OUserSelect = 'none'
    element.onselectstart = () => false
}

/**
 * Make an element draggable within a specified container.
 * @param {HTMLElement} targetEl - Element that triggers the drag event.
 * @param {HTMLElement} DragEl - Element to be dragged.
 */
export function dragging(targetEl: HTMLElement, DragEl: HTMLElement): void {
    // Initialize the interact.js library with the draggable element
    interact(DragEl).draggable({
        allowFrom: targetEl,
        listeners: {
            move(event) {
                updatePosition(
                    event.target as HTMLElement,
                    event.dx,
                    event.dy,
                    positions
                )
            },
        },
        modifiers: [
            interact.modifiers.restrictRect({
                restriction: 'body',
            }),
        ],
    })

    $(DragEl).on('mousedown', () => {
        $(`.draggable-panel:not(${DragEl})`).css('z-index', '99')
        $(DragEl).css('z-index', '99')
    })

    const panelElements = document.querySelectorAll(
        '.elementPanel, .layoutElementPanel, #moduleProperty, #layoutDialog, #verilogEditorPanel, .timing-diagram-panel, .testbench-manual-panel, .quick-btn'
    )

    // Disable selection only once per element
    panelElements.forEach((element) => {
        const el = element as any
        if (!el._selectionDisabled) {
            disableSelection(element as HTMLElement)
            el._selectionDisabled = true
        }
    })
}
