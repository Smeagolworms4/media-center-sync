export class Native {

	public static defined(obj: any): boolean {
		return typeof obj !== 'undefined';
	}

	public static empty(value: any): boolean {
		return value === null || typeof value === 'undefined' || value === '';
	}

	public static toInt(value: any): Nullable<number> {
		if (value === null || !this.defined(value)) {
			return null;
		}
		return parseInt(value.toString(), 10);
	}

	public static toFloat(value: any): Nullable<number> {
		if (value === null || !this.defined(value)) {
			return null;
		}
		return parseFloat(value.toString());
	}

	public static toBoolean(value: any): boolean {
		return !(!value || value === '0' || value.toString().toLowerCase() === 'false');
	}

	public static isInt(value: any): boolean {
		return !isNaN(parseInt(value, 10));
	}

	public static isBoolean(value: any): boolean {
		return typeof value == 'boolean';
	}

	public static callSetter (clazz: any, property: string, bind: any, value: any): void {
		Object.getOwnPropertyDescriptor(clazz.prototype, property)?.set?.call(bind, value);
	}

	public static callGetter (clazz: any, property: string, bind: any): any {
		return Object.getOwnPropertyDescriptor(clazz.prototype, property)?.get?.call(bind);
	}
}
