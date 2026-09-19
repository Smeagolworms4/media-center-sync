/**
 * Generate an uuid
 */
export class Uuid {
	public static generate (): string {
		function sTime (): string {
			return Date.now()
				.toString(16)
				.slice(1)
			;
		}
		function s4 (): string {
			return Math.floor((1 + Math.random()) * 0x1_00_00)
				.toString(16)
				.slice(1)
			;
		}
		return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + sTime();
	}
}
