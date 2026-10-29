/** Activate mouse/pen actions on press, retaining native keyboard and touch activation. */
export function press(action?: (button: HTMLButtonElement) => void) {
	return (button: HTMLButtonElement) => {
		let pressed = false;
		const activate = () => {
			if (button.disabled) return;
			if (action) action(button);
			else if (button.type === 'submit') button.form?.requestSubmit(button);
		};
		const down = (event: PointerEvent) => {
			pressed = false;
			if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch') return;
			event.preventDefault();
			pressed = true;
			activate();
		};
		const click = (event: MouseEvent) => {
			event.preventDefault();
			// Keyboard, assistive technology, menu drag selection, and touch still use click.
			if (event.detail === 0 || !pressed) activate();
			pressed = false;
		};
		button.addEventListener('pointerdown', down);
		button.addEventListener('click', click);
		return () => {
			button.removeEventListener('pointerdown', down);
			button.removeEventListener('click', click);
		};
	};
}

/** Native-style press-open, drag, release selection for a details/summary menu. */
export function pressMenu({ navigate = true }: { navigate?: boolean } = {}) {
	return (menu: HTMLDetailsElement) => {
		const summary = menu.querySelector('summary')!;
		const document = menu.ownerDocument;
		const window = document.defaultView!;
		let pointer: number | undefined;
		let touch = false;
		let highlighted: HTMLButtonElement | undefined;
		function highlight(button?: HTMLButtonElement) {
			highlighted?.removeAttribute('data-press-active');
			highlighted = button;
			highlighted?.setAttribute('data-press-active', '');
		}
		function itemAt(event: PointerEvent) {
			const target = document.elementFromPoint(event.clientX, event.clientY);
			const button = target?.closest<HTMLButtonElement>('button[data-menu-item]');
			return button && menu.contains(button) && !button.disabled ? button : undefined;
		}
		function close() {
			pointer = undefined;
			highlight();
			menu.open = false;
		}
		const down = (event: PointerEvent) => {
			touch = event.pointerType === 'touch';
			if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch') return;
			event.preventDefault();
			summary.focus({ preventScroll: true });
			if (menu.open) close();
			else {
				menu.open = true;
				pointer = event.pointerId;
			}
		};
		const click = (event: MouseEvent) => {
			// Native keyboard/touch summary activation remains available.
			if (event.detail > 0 && !touch) event.preventDefault();
			touch = false;
		};
		const outside = (event: PointerEvent) => {
			if (!menu.contains(event.target as Node)) close();
		};
		const move = (event: PointerEvent) => {
			if (event.pointerId === pointer && menu.open) highlight(itemAt(event));
		};
		const up = (event: PointerEvent) => {
			if (!menu.open) return;
			if (event.pointerId === pointer) {
				const button = itemAt(event);
				pointer = undefined;
				highlight();
				if (button) {
					event.preventDefault();
					button.click();
					return;
				}
			}
			const target = document.elementFromPoint(event.clientX, event.clientY);
			if (!target || !menu.contains(target)) close();
		};
		const cancel = (event: PointerEvent) => {
			if (event.pointerId === pointer) close();
		};
		const keyboard = (event: KeyboardEvent) => {
			if (!menu.open || event.defaultPrevented || event.isComposing) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				close();
				summary.focus();
			} else if (
				navigate &&
				menu.contains(document.activeElement) &&
				!event.altKey &&
				!event.ctrlKey &&
				!event.metaKey &&
				['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
			) {
				event.preventDefault();
				const items = [
					...menu.querySelectorAll<HTMLButtonElement>('button[data-menu-item]:enabled')
				];
				const current = items.indexOf(document.activeElement as HTMLButtonElement);
				const next =
					event.key === 'Home'
						? 0
						: event.key === 'End'
							? items.length - 1
							: event.key === 'ArrowDown'
								? (current + 1) % items.length
								: current < 0
									? items.length - 1
									: (current - 1 + items.length) % items.length;
				items[next]?.focus();
			}
		};
		summary.addEventListener('pointerdown', down);
		summary.addEventListener('click', click);
		document.addEventListener('pointerdown', outside);
		document.addEventListener('pointermove', move);
		document.addEventListener('pointerup', up);
		document.addEventListener('pointercancel', cancel);
		document.addEventListener('keydown', keyboard);
		window.addEventListener('blur', close);
		return () => {
			highlight();
			summary.removeEventListener('pointerdown', down);
			summary.removeEventListener('click', click);
			document.removeEventListener('pointerdown', outside);
			document.removeEventListener('pointermove', move);
			document.removeEventListener('pointerup', up);
			document.removeEventListener('pointercancel', cancel);
			document.removeEventListener('keydown', keyboard);
			window.removeEventListener('blur', close);
		};
	};
}
