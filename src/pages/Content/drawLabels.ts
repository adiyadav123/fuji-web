import {
  VISIBLE_TEXT_ATTRIBUTE_NAME,
  ARIA_LABEL_ATTRIBUTE_NAME,
  WEB_WAND_LABEL_ATTRIBUTE_NAME,
} from '../../constants';

const styleElem = document.createElement('style');
styleElem.setAttribute('type', 'text/css');
styleElem.innerHTML = `
._label_overlay_wrapper {
  position: absolute;
  z-index: 9999;
  top: 0;
  left: 0;
}
._label_overlay {
  position: absolute;
  opacity: 0.75;
  font-size: 7px;
}
._label_overlay > span {
  background-color: black;
  color: #fff;
  border-radius: 2px;
  padding: 2px 5px;
  position: absolute;
  z-index: 1;
  top: 100%;
  left: 50%;
  transform: translate(-50%,2px);
}
._label_overlay > span::after {
  content: "";
  position: absolute;
  top: -8px;
  left: 50%;
  margin-left: -4px;
  border-width: 4px;
  border-style: solid;
  border-color: transparent transparent black transparent;
}
`;
document.head.appendChild(styleElem);

function isElementNode(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function isInputElement(node: Node): node is HTMLInputElement {
  return isElementNode(node) && node.tagName === 'INPUT';
}

function isVisible(element: Element, checkViewport = false) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const { display, visibility, opacity } = style;
  if (display === 'none') return false;
  if (visibility !== 'visible') return false;
  if (opacity != null && parseFloat(opacity) < 0.1) return false; // considering something very close to 0 as invisible
  // don't respect 'aria-hidden' attribute since they are most likely visible to the user
  // if (element.getAttribute('aria-hidden') === 'true') return false;

  if (rect.width === 0 || rect.height === 0) return false;

  // check if the element is within the viewport
  if (checkViewport) {
    const windowHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const windowWidth =
      window.innerWidth || document.documentElement.clientWidth;
    if (
      rect.top > windowHeight ||
      rect.bottom < 0 ||
      rect.left > windowWidth ||
      rect.right < 0
    )
      return false;
  }

  return true;
}

type DomAttrs = {
  visibleText: string;
  ariaLabel: string;
};

const emptyDomAttrs: DomAttrs = {
  visibleText: '',
  ariaLabel: '',
};

// check if the node has the attributes we added
function isTouchedElement(elem: Element) {
  return (
    elem.hasAttribute(VISIBLE_TEXT_ATTRIBUTE_NAME) ||
    elem.hasAttribute(ARIA_LABEL_ATTRIBUTE_NAME)
  );
}

// find the visible text and best-match aria-label of the element
// note that this function has a side effect of writing the attributes in the DOM
function traverseDom(node: Node, selector: string): DomAttrs {
  if (node.nodeType === Node.TEXT_NODE) {
    return { visibleText: node.nodeValue ?? '', ariaLabel: '' };
  } else if (isElementNode(node)) {
    if (!isVisible(node)) return emptyDomAttrs; // skip if the element is not visible
    if (isTouchedElement(node)) {
      return {
        visibleText: node.getAttribute(VISIBLE_TEXT_ATTRIBUTE_NAME) ?? '',
        ariaLabel: node.getAttribute(ARIA_LABEL_ATTRIBUTE_NAME) ?? '',
      };
    }

    let visibleText = '';
    let ariaLabel = '';
    // aria-labelledby has higher priority than aria-label
    // https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-labelledby
    if (node.hasAttribute('aria-labelledby')) {
      // use Set to dedupe
      const ids = new Set<string>(
        node.getAttribute('aria-labelledby')?.split(' ') ?? []
      );

      const label = Array.from(ids)
        .map((id: string) => {
          const labelElem = document.getElementById(id);
          if (labelElem) {
            if (isInputElement(labelElem)) {
              // for input elements, use the value as the label
              return labelElem.value;
            }
            // doesn't matter if the text is visible or not
            return labelElem.textContent ?? '';
          }
        })
        .join(' ')
        .trim();

      if (ariaLabel.length === 0 && label.length > 0) {
        ariaLabel = label;
      }
    }
    if (ariaLabel.length === 0 && node.hasAttribute('aria-label')) {
      ariaLabel = node.getAttribute('aria-label') ?? '';
    }

    // skip children of SVGs because they have their own visibility rules
    if (node.tagName.toLocaleLowerCase() !== 'svg') {
      for (const child of node.childNodes) {
        const result = traverseDom(child, selector);
        // aggregate visible text
        visibleText += ' ' + result.visibleText;
        visibleText = visibleText.trim();
        // if parent doesn't have it, set aria-label with the first one found
        if (ariaLabel.length === 0 && result.ariaLabel.length > 0) {
          ariaLabel = result.ariaLabel;
        }
      }
    }
    visibleText = removeEmojis(visibleText);

    // cache attributes in DOM
    node.setAttribute(VISIBLE_TEXT_ATTRIBUTE_NAME, visibleText);
    node.setAttribute(ARIA_LABEL_ATTRIBUTE_NAME, ariaLabel);
    return { visibleText, ariaLabel };
  }
  return emptyDomAttrs;
}

// It removes all symbols except:
// \p{L} - all letters from any language
// \p{N} - numbers
// \p{P} - punctuation
// \p{Z} - whitespace separators
function removeEmojis(label: string) {
  return label.replace(/[^\p{L}\p{N}\p{P}\p{Z}^$\n]/gu, '').trim();
}

// a large base z-index to start with
const baseZIndex = 10000;

function drawLabelsOnSelector(selector: string) {
  // wrapper element
  const wrapper = document.createElement('div');
  wrapper.classList.add('_label_overlay_wrapper');
  // Get all elements that match the selector
  const elements = document.querySelectorAll(selector);
  // record times a label is used so that we can add a number to the end of the label
  const labelCounts = new Map<string, number>();

  // Iterate over the elements
  elements.forEach((elem, index) => {
    // skip if the element is already touched
    // this is avoid cases where the selector matches nested elements, e.g. an input and its parent label
    if (isTouchedElement(elem)) return;
    // if the element has aria-hidden="true", skip it
    if (elem.getAttribute('aria-hidden') === 'true') return;
    // if the tabindex is negative, skip it
    if (elem.hasAttribute('tabindex')) {
      const tabIndex = parseInt(elem.getAttribute('tabindex') ?? '');
      if (tabIndex < 0) return;
    }
    // if the element is not visible, skip it
    if (!isVisible(elem, true)) return;
    // if the element is an input, hopefully the value or the placeholder is visible
    if (isInputElement(elem)) {
      const visibleTextOnInput = removeEmojis(
        elem.value || elem.placeholder || ''
      );
      if (elem.value.length > 0 || elem.placeholder.length > 0) {
        elem.setAttribute(WEB_WAND_LABEL_ATTRIBUTE_NAME, visibleTextOnInput);
        return;
      }
    }

    const { visibleText, ariaLabel } = traverseDom(elem, selector);
    // if the element already has visible text, just use it as label and skip
    // TODO: detect and avoid duplication
    if (visibleText !== '') {
      console.log(visibleText);
      elem.setAttribute(WEB_WAND_LABEL_ATTRIBUTE_NAME, visibleText);
      return;
    }
    // use the aria-label if it exists
    let labelBase = '';
    if (ariaLabel.length > 0) {
      labelBase = ariaLabel;
    }
    // fallback to tag+index
    if (labelBase.length === 0) {
      // for tag A we use "button" for better readability
      const tagName =
        elem.tagName === 'A' ? 'button' : elem.tagName.toLowerCase();
      labelBase = `${tagName}#${index}`;
    }

    // increment the count for this label
    const count = labelCounts.get(labelBase) ?? 0;
    labelCounts.set(labelBase, count + 1);
    // if the label is used more than once, add a number to the end (start from 2)
    const labelSuffix = count > 0 ? `#${count + 1}` : '';

    const label = `${labelBase}${labelSuffix}`;
    // set attribute so it's easier to find the element with selector
    elem.setAttribute(WEB_WAND_LABEL_ATTRIBUTE_NAME, label);

    const rect = elem.getBoundingClientRect();
    // Create a new <div>
    const overlayDiv = document.createElement('div');
    overlayDiv.classList.add('_label_overlay');
    // Set the overlay's styles to match the position and size of the element
    Object.assign(overlayDiv.style, {
      top: `${window.scrollY + rect.top}px`, // considering the scrolled amount
      left: `${window.scrollX + rect.left}px`, // considering the scrolled amount
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: baseZIndex + index, // place the overlay above previous ones
    });

    overlayDiv.innerHTML = `<span>${label}</span>`; // add the index of the element as text

    // Add the overlay to the wrapper
    wrapper.appendChild(overlayDiv);
  });

  document.body.appendChild(wrapper);
}

const selectorForInteractiveElements =
  'a, button, details, input, label, option, select, textarea, ' +
  '[onclick], [onmouseover], [onmousedown], [onmouseup],' + // we don't include keyboard events yet
  '[role="button"], [role="link"], [role="textbox"]';

export function drawLabels() {
  drawLabelsOnSelector(selectorForInteractiveElements);
}

export function removeLabels() {
  document.querySelectorAll('._label_overlay_wrapper').forEach((elem) => {
    elem.remove();
  });
}