/**
 * Shift definitions for counting scans
 * 
 * Shifts:
 * - Day:      7:30 AM to 5:30 PM
 * - Overtime: 5:30 PM to 10:30 PM
 * - Night:    10:30 PM to 7:30 AM (next day)
 */

const SHIFTS = {
    DAY: {
        name: 'Day',
        startHour: 7,
        startMinute: 30,
        endHour: 17,
        endMinute: 30
    },
    OVERTIME: {
        name: 'Overtime',
        startHour: 17,
        startMinute: 30,
        endHour: 22,
        endMinute: 30
    },
    NIGHT: {
        name: 'Night',
        startHour: 22,
        startMinute: 30,
        endHour: 7, // Next day
        endMinute: 30
    }
};

/**
 * Get current shift based on current time
 */
function getCurrentShift(date = new Date()) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const timeValue = hours * 60 + minutes;

    // Day: 7:30 (450) to 17:30 (1050)
    if (timeValue >= 450 && timeValue < 1050) {
        return SHIFTS.DAY;
    }
    // Overtime: 17:30 (1050) to 22:30 (1350)
    if (timeValue >= 1050 && timeValue < 1350) {
        return SHIFTS.OVERTIME;
    }
    // Night: 22:30 (1350) to 7:30 (450) next day
    return SHIFTS.NIGHT;
}

/**
 * Get the start and end datetime for the current shift
 * Used to query the database for shift counts
 */
function getShiftTimeRange(date = new Date()) {
    const shift = getCurrentShift(date);
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();

    let startDate, endDate;

    if (shift === SHIFTS.DAY) {
        startDate = new Date(year, month, day, 7, 30, 0);
        endDate = new Date(year, month, day, 17, 30, 0);
    } else if (shift === SHIFTS.OVERTIME) {
        startDate = new Date(year, month, day, 17, 30, 0);
        endDate = new Date(year, month, day, 22, 30, 0);
    } else {
        // Night shift - handle crossing midnight
        const hours = date.getHours();
        if (hours < 7 || (hours === 7 && date.getMinutes() < 30)) {
            // Early morning (after midnight) - shift started yesterday
            startDate = new Date(year, month, day - 1, 22, 30, 0);
            endDate = new Date(year, month, day, 7, 30, 0);
        } else {
            // Late night (before midnight) - shift ends tomorrow
            startDate = new Date(year, month, day, 22, 30, 0);
            endDate = new Date(year, month, day + 1, 7, 30, 0);
        }
    }

    return {
        shift: shift.name,
        startDate,
        endDate,
        startStr: formatDateTime(startDate),
        endStr: formatDateTime(endDate)
    };
}

/**
 * Format date as MySQL DATETIME string
 */
function formatDateTime(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Get current date as YYYY-MM-DD for folder_date
 */
function getCurrentDateStr(date = new Date()) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = {
    SHIFTS,
    getCurrentShift,
    getShiftTimeRange,
    formatDateTime,
    getCurrentDateStr
};
