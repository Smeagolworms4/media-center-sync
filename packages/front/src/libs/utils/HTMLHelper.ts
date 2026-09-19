export class HTMLHelper {
	public static findParentByTag (element: HTMLElement, tagName: string): Nullable<HTMLElement> {
		tagName = tagName.toUpperCase();
		while (element && element !== document.documentElement) {
			if (element.tagName === tagName) {
				return element;
			}
			element = element.parentElement as HTMLElement;
		}
		return null;
	}
}
