export interface CronDescription {
	/** i18n key of the sentence describing the expression. */
	key: string;
	params: Record<string, string | number>;
}

function pad (value: number): string {
	return String(value).padStart(2, '0');
}

function isNumber (field: string): boolean {
	return /^\d+$/.test(field);
}

/**
 * A cron expression in words.
 *
 * Nobody reads `0 4 * * 1` and pictures Monday morning, and a schedule somebody
 * misread is one that runs a full rescan at the wrong hour for months. Only the
 * handful of shapes people actually write are recognised; anything else is
 * honestly reported as an expression the interface cannot summarise rather than
 * guessed at.
 */
export function describeCron (expression: string | null | undefined): CronDescription | null {
	if (!expression || expression.trim().length === 0) {
		return null;
	}
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		return { key: 'cron.describe.invalid', params: {} };
	}

	const [minute, hour, day, month, weekday] = fields;
	const everyDate = day === '*' && month === '*';

	if (fields.every(field => field === '*')) {
		return { key: 'cron.describe.every_minute', params: {} };
	}

	const stepMatch = /^\*\/(\d+)$/.exec(minute);
	if (stepMatch && hour === '*' && everyDate && weekday === '*') {
		return { key: 'cron.describe.every_n_minutes', params: { count: Number(stepMatch[1]) } };
	}

	const hourStep = /^\*\/(\d+)$/.exec(hour);
	if (isNumber(minute) && hourStep && everyDate && weekday === '*') {
		return {
			key: 'cron.describe.every_n_hours',
			params: { count: Number(hourStep[1]), minute: pad(Number(minute)) },
		};
	}

	if (isNumber(minute) && hour === '*' && everyDate && weekday === '*') {
		return { key: 'cron.describe.hourly_at', params: { minute: pad(Number(minute)) } };
	}

	if (isNumber(minute) && isNumber(hour)) {
		const time = `${pad(Number(hour))}:${pad(Number(minute))}`;

		if (everyDate && weekday === '*') {
			return { key: 'cron.describe.daily_at', params: { time } };
		}
		if (everyDate && isNumber(weekday)) {
			// Both 0 and 7 mean Sunday in every cron dialect worth supporting.
			return { key: 'cron.describe.weekly_at', params: { day: Number(weekday) % 7, time } };
		}
		if (isNumber(day) && month === '*' && weekday === '*') {
			return { key: 'cron.describe.monthly_at', params: { day: Number(day), time } };
		}
	}

	return { key: 'cron.describe.custom', params: {} };
}

export function useCron () {
	return { describeCron };
}
