export class UriHelper {

	public static queries(params: { [key: string]: any }, sep: string = '?'): string {
		const qs = Object.entries(params)
			.map(([ key, value ]) => {
				if (Array.isArray(value)) {
					return value.map(v => `${encodeURIComponent(key)}[]=${encodeURIComponent(v)}`)
				}
				return [ `${encodeURIComponent(key)}=${encodeURIComponent(value)}` ];
			})
			.flat()
			.join('&')
		;
		return (qs && sep || '') + qs;
	}

	public static getParameterByName(name: string, url = window.location.href) {
		name = name.replace(/[\[\]]/g, '\\$&');
		const regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)'),
			results = regex.exec(url);
		if (!results) return null;
		if (!results[2]) return '';
		return decodeURIComponent(results[2].replace(/\+/g, ' '));
	}
}
