import absolutePath from './absolutePath';
import byteSize from './byteSize';
import cron from './cron';
import email from './email';
import fileFormats from './fileFormats';
import fileSize from './fileSize';
import maxlength from './maxlength';
import minlength from './minlength';
import notNull from './notNull';
import object from './object';
import onlyInteger from './onlyInteger';
import onlyLetters from './onlyLetters';
import password from './password';
import passwordClass from './passwordClass';
import range from './range';
import regExp from './regExp';
import repeatField from './repeatField';
import required from './required';
import url from './url';
import urlWithPort from './urlWithPort';

const validators = {
	absolutePath,
	byteSize,
	cron,
	email,
	fileFormats,
	fileSize,
	maxlength,
	minlength,
	notNull,
	object,
	onlyInteger,
	onlyLetters,
	password,
	passwordClass,
	range,
	regExp,
	repeatField,
	required,
	url,
	urlWithPort,
};

export default validators;
