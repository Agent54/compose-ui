/// <reference lib="dom" />
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { press, pressMenu } from '../src/lib/shell/press.ts';

function event(type: string, properties: Record<string, unknown> = {}) {
	return Object.assign(new Event(type, { cancelable: true }), {
		button: 0,
		isPrimary: true,
		pointerType: 'mouse',
		pointerId: 1,
		clientX: 0,
		clientY: 0,
		detail: 1,
		...properties
	});
}

class Button extends EventTarget {
	disabled = false;
	type = 'button';
	submissions = 0;
	form = { requestSubmit: () => this.submissions++ };
	attributes = new Set<string>();
	setAttribute(name: string) {
		this.attributes.add(name);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	closest() {
		return this;
	}
	focus() {}
	click() {
		this.dispatchEvent(event('click', { detail: 0 }));
	}
	get element() {
		return this as unknown as HTMLButtonElement;
	}
}

test('actions fire on primary mouse down, once per gesture, with keyboard and touch fallback', () => {
	const button = new Button();
	let calls = 0;
	const detach = press(() => calls++)(button.element);
	button.dispatchEvent(event('pointerdown'));
	assert.equal(calls, 1, 'activation must happen before mouseup');
	button.dispatchEvent(event('click'));
	assert.equal(calls, 1, 'the follow-up click must not repeat the action');
	button.click();
	assert.equal(calls, 2, 'keyboard/assistive activation must work');
	button.dispatchEvent(event('pointerdown', { pointerType: 'touch' }));
	assert.equal(calls, 2, 'touch scrolling must not activate on touch down');
	button.dispatchEvent(event('click'));
	assert.equal(calls, 3);
	button.disabled = true;
	button.dispatchEvent(event('pointerdown'));
	button.click();
	assert.equal(calls, 3);
	button.disabled = false;
	detach();
	button.dispatchEvent(event('pointerdown'));
	assert.equal(calls, 3, 'unmounted actions must release their listeners');
});

test('submit buttons submit once on press and once for a keyboard activation', () => {
	const button = new Button();
	button.type = 'submit';
	press()(button.element);
	button.dispatchEvent(event('pointerdown'));
	assert.equal(button.submissions, 1);
	button.dispatchEvent(event('click'));
	assert.equal(button.submissions, 1);
	button.click();
	assert.equal(button.submissions, 2);
});

// EventTargets let these tests verify event ordering without adding a DOM dependency.
function menuFixture() {
	const summary = new Button();
	const item = new Button();
	const disabled = new Button();
	disabled.disabled = true;
	const document = Object.assign(new EventTarget(), {
		activeElement: summary,
		defaultView: new EventTarget(),
		elementFromPoint: () => point
	});
	let point: Button | null = summary;
	const menu = Object.assign(new EventTarget(), {
		open: false,
		ownerDocument: document,
		querySelector: () => summary,
		querySelectorAll: () => [item],
		contains: (node: unknown) => [summary, item, disabled].includes(node as Button)
	});
	for (const button of [summary, item, disabled])
		button.focus = () => {
			document.activeElement = button;
		};
	let selected = 0;
	press(() => {
		selected++;
		menu.open = false;
	})(item.element);
	const detach = pressMenu()(menu as unknown as HTMLDetailsElement);
	return {
		summary,
		item,
		disabled,
		menu,
		document,
		detach,
		pointAt: (button: Button | null) => {
			point = button;
		},
		selected: () => selected
	};
}

test('menu opens on mouse down, selects a dragged-to item on release, and suppresses trigger click', () => {
	const f = menuFixture();
	f.summary.dispatchEvent(event('pointerdown'));
	assert(f.menu.open, 'the menu must be open while the mouse is still down');
	f.pointAt(f.item);
	f.document.dispatchEvent(event('pointermove'));
	assert(f.item.attributes.has('data-press-active'));
	assert.equal(f.selected(), 0, 'dragging across an item must not activate it');
	f.document.dispatchEvent(event('pointerup'));
	assert.equal(f.selected(), 1);
	assert(!f.menu.open);
	assert(!f.item.attributes.has('data-press-active'));
	const click = event('click');
	f.summary.dispatchEvent(click);
	assert(click.defaultPrevented, 'release must not toggle the trigger a second time');
	assert.equal(f.selected(), 1);
});

test('releasing on the trigger leaves the menu open; releasing outside dismisses it', () => {
	const f = menuFixture();
	f.summary.dispatchEvent(event('pointerdown'));
	f.document.dispatchEvent(event('pointerup'));
	assert(f.menu.open);
	f.summary.dispatchEvent(event('click'));
	assert(f.menu.open);
	f.pointAt(null);
	f.document.dispatchEvent(event('pointerup'));
	assert(!f.menu.open);
	assert.equal(f.selected(), 0);
});

test('disabled rows, canceled gestures, and window blur never select an item', () => {
	const f = menuFixture();
	f.summary.dispatchEvent(event('pointerdown'));
	f.pointAt(f.disabled);
	f.document.dispatchEvent(event('pointerup'));
	assert.equal(f.selected(), 0);
	assert(f.menu.open);
	f.summary.dispatchEvent(event('pointerdown')); // close
	f.summary.dispatchEvent(event('pointerdown')); // start another gesture
	f.document.dispatchEvent(event('pointercancel'));
	assert(!f.menu.open);
	f.summary.dispatchEvent(event('pointerdown'));
	f.document.defaultView.dispatchEvent(event('blur'));
	assert(!f.menu.open);
	f.detach();
	f.summary.dispatchEvent(event('pointerdown'));
	assert(!f.menu.open);
});

test('menus preserve keyboard/touch toggling, arrow focus, and Escape dismissal', () => {
	const f = menuFixture();
	const keyboardClick = event('click', { detail: 0 });
	f.summary.dispatchEvent(keyboardClick);
	assert(!keyboardClick.defaultPrevented);
	f.summary.dispatchEvent(event('pointerdown', { pointerType: 'touch' }));
	const touchClick = event('click'); // Safari can expose touch clicks as MouseEvent.
	f.summary.dispatchEvent(touchClick);
	assert(!touchClick.defaultPrevented);
	f.menu.open = true;
	f.document.dispatchEvent(event('keydown', { key: 'ArrowDown' }));
	assert.equal(f.document.activeElement, f.item);
	f.document.dispatchEvent(event('keydown', { key: 'Escape' }));
	assert(!f.menu.open);
	assert.equal(f.document.activeElement, f.summary);
});
