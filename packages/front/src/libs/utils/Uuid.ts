/**
 * Generate an uuid
 */
export class Uuid {
	public static generate(): string {
		
		function sTime(): string {
			return (new Date).getTime()
				.toString(16)
				.substring(1)
			;
		}
		function s4(): string {
			return Math.floor((1 + Math.random()) * 0x10000)
				.toString(16)
				.substring(1)
			;
		}
		return s4() + s4() + '-' + s4() + '-' + s4() + '-' +s4() + '-' + sTime();
	}
}